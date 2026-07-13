/**
 * httpTransport - first-class HTTP task facade for external dispatchers.
 *
 * Lets an external service dispatch coding tasks without speaking the
 * effect-RPC WebSocket protocol. A task is a STANDALONE AUTOMATION RUN: `POST
 * /api/tasks` maps onto `AutomationService.create` (schedule `manual`, mode
 * `standalone`) + `AutomationService.runNow`, so every run gets a fresh thread
 * + turn and done-detection stays fully server-side —
 * `AutomationRunReactor`/`AutomationService.reconcileThread` derive
 * succeeded/failed/interrupted/waiting-for-approval from the thread shell.
 * This module deliberately reimplements NO orchestration: it only translates
 * HTTP requests onto the existing automation/orchestration services.
 *
 * Routes (all bearer/cookie-authenticated via `ServerAuth.authenticateHttpRequest`,
 * the same posture as the rest of the HTTP surface):
 *
 * - `POST /api/tasks` — create + immediately run a task. Responds
 *   `{taskId, threadId, status}` where `taskId` is the automation run id.
 * - `GET /api/tasks?name=<exact>` — read-only lookup of existing runs by the
 *   task's exact name (optionally scoped with `&projectId=`), newest first.
 *   This is the lookup-before-create half of idempotent dispatch: an external
 *   caller derives a deterministic name (e.g. thread+turn key), looks it up,
 *   and only POSTs when no run exists yet.
 * - `GET /api/tasks/:id/events?after=N` — cursor over the durable
 *   orchestration event log filtered to the task's thread (see `./events.ts`
 *   for the external union), plus a per-poll snapshot of the run row, the
 *   thread's `lastKnownPr`, and pending approvals. `nextCursor` is the highest
 *   event sequence scanned (the log is global, so the cursor advances past
 *   other threads' events too).
 * - `POST /api/tasks/:id/input` — respond to a pending approval or user-input
 *   request, or send a follow-up user turn on the task's thread.
 *
 * Known v0 semantics: a follow-up `message` after the run is terminal starts a
 * real turn on the thread but does NOT reopen the AutomationRun
 * (`AutomationRepository.getRunByThreadId` ignores terminal rows), so
 * `run.status` stays terminal while thread events keep flowing.
 *
 * @module httpTransport
 */
import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  AutomationCreateInput,
  AutomationRunId,
  AutomationWorktreeMode,
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderStartOptions,
  ProviderUserInputAnswers,
  RuntimeMode,
  TrimmedNonEmptyString,
  type AutomationRun,
  type OrchestrationCommand,
  type ThreadId,
} from "@synara/contracts";
import { Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authErrorResponse, makeEffectAuthRequest } from "../auth/http.ts";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { AutomationServiceError } from "../automation/Errors.ts";
import { AutomationService } from "../automation/Services/AutomationService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../persistence/Services/AutomationRepository.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { toTaskEvent } from "./events.ts";

export const TASK_API_ROUTE_PATH = "/api/tasks";

/** Max events scanned per poll; the caller re-polls from `nextCursor` for more. */
const EVENTS_PAGE_LIMIT = 1_000;

const TASK_NAME_MAX_CHARS = 160;

/**
 * Appended to the prompt when `deliverPr: true`. PR delivery is prompt-level
 * on purpose: synara's provider sessions already ship PRs first-class
 * (worktrees, commits, `GitHubCli.createPullRequest`), and the resulting PR
 * surfaces on the thread shell as `lastKnownPr` — no engine knob exists or is
 * needed.
 */
const DELIVER_PR_INSTRUCTION =
  "When the task is complete, commit your work and open a pull request for it.";

const TaskCreateRequest = Schema.Struct({
  projectId: ProjectId,
  prompt: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(TASK_NAME_MAX_CHARS))),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  worktreeMode: Schema.optional(AutomationWorktreeMode),
  /**
   * Branch whose LATEST ORIGIN state the task starts from: dispatch fetches
   * `origin/<baseBranch>` and bases the run worktree on it. Omitted = today's
   * behavior (branch off the workspace's checked-out local tip, no fetch).
   */
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  acknowledgedRisks: Schema.optional(
    Schema.Array(Schema.Literals(["full-access", "local-checkout", "fast-interval"])),
  ),
  deliverPr: Schema.optional(Schema.Boolean),
});

const TaskInputRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("approval"),
    approvalId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  }),
  Schema.Struct({
    type: Schema.Literal("user-input"),
    approvalId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  }),
  Schema.Struct({
    type: Schema.Literal("message"),
    text: TrimmedNonEmptyString,
  }),
]);

const decodeTaskCreateRequest = Schema.decodeUnknownEffect(TaskCreateRequest);
const decodeTaskInputRequest = Schema.decodeUnknownEffect(TaskInputRequest);
const decodeAutomationCreateInput = Schema.decodeUnknownEffect(AutomationCreateInput);

/** Error carrying a ready HTTP response; `respondWith` builds one to `yield*`. */
class TaskApiRouteError extends Data.TaggedError("TaskApiRouteError")<{
  readonly response: HttpServerResponse.HttpServerResponse;
}> {}

function respondWith(status: number, message: string): TaskApiRouteError {
  return new TaskApiRouteError({
    response: HttpServerResponse.jsonUnsafe({ error: message }, { status }),
  });
}

const requireAuthenticated = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  return yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
});

const readJsonBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.mapError(() => respondWith(400, "Invalid JSON body.")));

/** Read the `:taskId` route param (task id = automation run id). */
const requireTaskIdParam = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const rawTaskId = params.taskId;
  if (!rawTaskId) {
    return yield* respondWith(404, "Not Found");
  }
  try {
    return decodeURIComponent(rawTaskId);
  } catch {
    return yield* respondWith(404, "Not Found");
  }
});

const requireRun = (taskId: string) =>
  Effect.gen(function* () {
    const automationRepository = yield* AutomationRepository;
    const runOption = yield* automationRepository.getRunById({
      id: AutomationRunId.makeUnsafe(taskId),
    });
    if (Option.isNone(runOption)) {
      return yield* respondWith(404, "Unknown task id.");
    }
    return runOption.value;
  });

/**
 * Uniform error handling for every task API route: auth failures keep their
 * own status, deliberate route errors carry a prepared response, automation
 * service failures are caller-visible validation problems (400), and anything
 * else (persistence, dispatch internals) is an opaque 500.
 */
function errorResponse(error: unknown): HttpServerResponse.HttpServerResponse {
  if (error instanceof TaskApiRouteError) return error.response;
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof AutomationServiceError) {
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 });
  }
  return HttpServerResponse.jsonUnsafe({ error: "Internal server error." }, { status: 500 });
}

const handled = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))));

function deriveTaskName(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  const name = firstLine.slice(0, TASK_NAME_MAX_CHARS).trim();
  return name.length > 0 ? name : "Task";
}

function makeTaskApiCommandId(): CommandId {
  return CommandId.makeUnsafe(`taskapi:${randomUUID()}`);
}

const createTaskRoute = HttpRouter.add(
  "POST",
  TASK_API_ROUTE_PATH,
  handled(
    Effect.gen(function* () {
      yield* requireAuthenticated;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* readJsonBody(request);
      const input = yield* decodeTaskCreateRequest(body).pipe(
        Effect.mapError((cause) => respondWith(400, `Invalid task request: ${String(cause)}`)),
      );

      // `AutomationCreateInput.modelSelection` is required, so an omitted
      // selection falls back to the project's default model.
      const projection = yield* ProjectionSnapshotQuery;
      const projectOption = yield* projection.getProjectShellById(input.projectId);
      if (Option.isNone(projectOption)) {
        return yield* respondWith(404, "Unknown projectId.");
      }
      const modelSelection = input.modelSelection ?? projectOption.value.defaultModelSelection;
      if (!modelSelection) {
        return yield* respondWith(
          400,
          "modelSelection is required: the project has no default model selection.",
        );
      }

      const prompt = input.deliverPr
        ? `${input.prompt}\n\n${DELIVER_PR_INSTRUCTION}`
        : input.prompt;
      const createInput = yield* decodeAutomationCreateInput({
        projectId: input.projectId,
        name: input.name ?? deriveTaskName(input.prompt),
        prompt,
        schedule: { type: "manual" },
        mode: "standalone",
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        ...(input.worktreeMode ? { worktreeMode: input.worktreeMode } : {}),
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
        ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        ...(input.acknowledgedRisks ? { acknowledgedRisks: input.acknowledgedRisks } : {}),
      }).pipe(
        Effect.mapError((cause) => respondWith(400, `Invalid task request: ${String(cause)}`)),
      );

      const automationService = yield* AutomationService;
      const definition = yield* automationService.create(createInput);
      const { run } = yield* automationService.runNow({ automationId: definition.id });
      return HttpServerResponse.jsonUnsafe(
        { taskId: run.id, threadId: run.threadId, status: run.status },
        { status: 201 },
      );
    }),
  ),
);

/**
 * Read-only lookup by exact task name for idempotent dispatch. Task names are
 * automation-definition names, so this lists (non-archived) definitions via
 * `AutomationService.list` and returns their runs newest-first. Only RUNS are
 * returned: a definition whose `runNow` never produced a run costs nothing,
 * so a re-create after that failure is safe — the double-spawn hazard is the
 * run, not the definition.
 */
const listTasksRoute = HttpRouter.add(
  "GET",
  TASK_API_ROUTE_PATH,
  handled(
    Effect.gen(function* () {
      yield* requireAuthenticated;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (!url) return yield* respondWith(400, "Bad Request");
      const name = url.searchParams.get("name")?.trim();
      if (!name) {
        return yield* respondWith(
          400,
          "Query parameter `name` is required (exact-match task lookup).",
        );
      }
      const rawProjectId = url.searchParams.get("projectId");

      const automationService = yield* AutomationService;
      const listed = yield* automationService.list(
        rawProjectId ? { projectId: ProjectId.makeUnsafe(rawProjectId) } : {},
      );
      const matchingDefinitionIds = new Set(
        listed.definitions.filter((definition) => definition.name === name).map((d) => d.id),
      );
      const tasks = listed.runs
        .filter((run) => matchingDefinitionIds.has(run.automationId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((run) => ({
          taskId: run.id,
          threadId: run.threadId,
          status: run.status,
          name,
          projectId: run.projectId,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        }));
      return HttpServerResponse.jsonUnsafe({ tasks });
    }),
  ),
);

function parseAfterCursor(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

const taskEventsRoute = HttpRouter.add(
  "GET",
  `${TASK_API_ROUTE_PATH}/:taskId/events`,
  handled(
    Effect.gen(function* () {
      yield* requireAuthenticated;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (!url) return yield* respondWith(400, "Bad Request");
      const taskId = yield* requireTaskIdParam;
      const run = yield* requireRun(taskId);
      const after = parseAfterCursor(url.searchParams.get("after"));

      const eventStore = yield* OrchestrationEventStore;
      const scanned = Array.from(
        yield* Stream.runCollect(eventStore.readFromSequence(after, EVENTS_PAGE_LIMIT)),
      );
      const nextCursor = scanned.length > 0 ? scanned[scanned.length - 1]!.sequence : after;
      const threadId = run.threadId;
      const events = threadId
        ? scanned
            .filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId)
            .flatMap((event) => {
              const mapped = toTaskEvent(event);
              return mapped ? [mapped] : [];
            })
        : [];

      const projection = yield* ProjectionSnapshotQuery;
      const shellOption = threadId ? yield* projection.getThreadShellById(threadId) : Option.none();
      const pendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
      const approvalRows = threadId
        ? yield* pendingApprovalRepository.listByThreadId({ threadId })
        : [];
      const pendingApprovals = approvalRows
        .filter((row) => row.status === "pending")
        .map((row) => ({
          approvalId: row.requestId,
          turnId: row.turnId,
          createdAt: row.createdAt,
        }));

      return HttpServerResponse.jsonUnsafe({
        taskId: run.id,
        threadId,
        run: {
          status: run.status,
          error: run.error,
          result: run.result,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        },
        lastKnownPr: Option.match(shellOption, {
          onNone: () => null,
          onSome: (shell) => shell.lastKnownPr,
        }),
        pendingApprovals,
        events,
        nextCursor,
      });
    }),
  ),
);

function makeInputCommand(
  run: AutomationRun,
  threadId: ThreadId,
  input: typeof TaskInputRequest.Type,
): OrchestrationCommand {
  const createdAt = new Date().toISOString();
  switch (input.type) {
    case "approval":
      return {
        type: "thread.approval.respond",
        commandId: makeTaskApiCommandId(),
        threadId,
        requestId: input.approvalId,
        decision: input.decision,
        createdAt,
      };
    case "user-input":
      return {
        type: "thread.user-input.respond",
        commandId: makeTaskApiCommandId(),
        threadId,
        requestId: input.approvalId,
        answers: input.answers,
        createdAt,
      };
    case "message": {
      // Mirror of the automation engine's own follow-up turn dispatch
      // (`AutomationService.dispatchRun`'s heartbeat branch): reuse the run's
      // permission snapshot so a follow-up cannot escalate the task's modes.
      const snapshot = run.permissionSnapshot;
      return {
        type: "thread.turn.start",
        commandId: makeTaskApiCommandId(),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(`taskapi:${randomUUID()}`),
          role: "user",
          text: input.text,
          attachments: [],
        },
        modelSelection: snapshot.modelSelection,
        ...(snapshot.providerOptions ? { providerOptions: snapshot.providerOptions } : {}),
        dispatchMode: "queue",
        dispatchOrigin: "automation",
        runtimeMode: snapshot.runtimeMode,
        interactionMode: snapshot.interactionMode,
        createdAt,
      };
    }
  }
}

const taskInputRoute = HttpRouter.add(
  "POST",
  `${TASK_API_ROUTE_PATH}/:taskId/input`,
  handled(
    Effect.gen(function* () {
      yield* requireAuthenticated;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const taskId = yield* requireTaskIdParam;
      const body = yield* readJsonBody(request);
      const input = yield* decodeTaskInputRequest(body).pipe(
        Effect.mapError((cause) => respondWith(400, `Invalid task input: ${String(cause)}`)),
      );
      const run = yield* requireRun(taskId);
      const threadId = run.threadId;
      if (!threadId) {
        return yield* respondWith(409, "Task has no thread yet.");
      }

      const command = makeInputCommand(run, threadId, input);
      const orchestrationEngine = yield* OrchestrationEngineService;
      const runtimeStartup = yield* ServerRuntimeStartup;
      // Queue behind startup reconciliation, exactly like the ws RPC's
      // dispatchCommand method. A fresh commandId is minted per HTTP request
      // (above) so the engine's receipt dedupe never silently drops a retry.
      yield* runtimeStartup
        .enqueueCommand(orchestrationEngine.dispatch(command))
        .pipe(Effect.mapError((error) => respondWith(400, error.message)));
      return HttpServerResponse.jsonUnsafe(
        { taskId: run.id, threadId, commandId: command.commandId },
        { status: 202 },
      );
    }),
  ),
);

export const taskApiRouteLayer = Layer.mergeAll(
  createTaskRoute,
  listTasksRoute,
  taskEventsRoute,
  taskInputRoute,
);
