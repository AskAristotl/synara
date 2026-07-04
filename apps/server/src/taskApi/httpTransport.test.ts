// Integration test for the task API HTTP transport. Boots the real
// `taskApiRouteLayer` (the same layer `http.ts` wires into
// `makeEffectHttpRouteLayer`) behind a real HTTP listener, mirroring
// `subagentMcp/httpTransport.test.ts`. Collaborators are provided as
// `Layer.succeed` test doubles so this stays focused on the transport's own
// job: authentication, request decoding, create/runNow translation, the
// events cursor projection, and input-to-command mapping. The
// automation/orchestration semantics behind those services are covered by
// `automation/Layers/AutomationService.test.ts` and the orchestration suites.
import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AutomationId,
  AutomationRunId,
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ApprovalRequestId,
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationListResult,
  type AutomationRun,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadPullRequest,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "../auth/Services/ServerAuth.ts";
import { AutomationServiceError } from "../automation/Errors.ts";
import {
  AutomationService,
  type AutomationServiceShape,
} from "../automation/Services/AutomationService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  AutomationRepository,
  type AutomationRepositoryShape,
} from "../persistence/Services/AutomationRepository.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../persistence/Services/OrchestrationEventStore.ts";
import {
  ProjectionPendingApprovalRepository,
  type ProjectionPendingApproval,
  type ProjectionPendingApprovalRepositoryShape,
} from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { taskApiRouteLayer } from "./httpTransport.ts";

const VALID_TOKEN = "a-valid-task-api-bearer-token";
const now = "2026-07-03T10:00:00.000Z";

const projectId = ProjectId.makeUnsafe("task-api-project");
const project: OrchestrationProjectShell = {
  id: projectId,
  kind: "project",
  title: "Task API Project",
  workspaceRoot: "/tmp/task-api-project",
  defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
};

const runId = AutomationRunId.makeUnsafe("automation-run:task-api-test");
const threadId = ThreadId.makeUnsafe(`automation:${runId}:thread`);
const otherThreadId = ThreadId.makeUnsafe("some-other-thread");

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: runId,
    automationId: AutomationId.makeUnsafe("automation:task-api-test"),
    projectId,
    threadId,
    turnId: null,
    trigger: { type: "manual" },
    status: "running",
    scheduledFor: now,
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    startedAt: now,
    finishedAt: null,
    threadCreateCommandId: CommandId.makeUnsafe(`automation:${runId}:thread-create`),
    turnStartCommandId: CommandId.makeUnsafe(`automation:${runId}:turn-start`),
    messageId: MessageId.makeUnsafe(`automation:${runId}:message`),
    error: null,
    result: null,
    permissionSnapshot: {
      provider: "codex",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      worktreeMode: "auto",
      allowedCapabilities: ["send-turn"],
      createdAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mutable harness state (reset per test)
// ---------------------------------------------------------------------------

let createdInputs: AutomationCreateInput[] = [];
let runNowInputs: Array<{ readonly automationId: string }> = [];
let dispatchedCommands: OrchestrationCommand[] = [];
let storedEvents: OrchestrationEvent[] = [];
let runById: Option.Option<AutomationRun> = Option.none();
let projectShell: Option.Option<OrchestrationProjectShell> = Option.some(project);
let pendingApprovalRows: ReadonlyArray<ProjectionPendingApproval> = [];
let lastKnownPr: OrchestrationThreadPullRequest | null = null;
let createFailure: AutomationServiceError | null = null;
let listResult: AutomationListResult = { definitions: [], runs: [] };
let listInputs: unknown[] = [];

function resetHarness() {
  createdInputs = [];
  runNowInputs = [];
  dispatchedCommands = [];
  storedEvents = [];
  runById = Option.none();
  projectShell = Option.some(project);
  pendingApprovalRows = [];
  lastKnownPr = null;
  createFailure = null;
  listResult = { definitions: [], runs: [] };
  listInputs = [];
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const fakeServerAuth = {
  authenticateHttpRequest: (request: { readonly headers: Record<string, string | undefined> }) => {
    const header = request.headers.authorization;
    if (header === `Bearer ${VALID_TOKEN}`) {
      return Effect.succeed({
        sessionId: "session-1",
        subject: "test-client",
        method: "bearer",
        role: "client",
      });
    }
    return Effect.fail(new AuthError({ message: "Unauthorized", status: 401 }));
  },
} as unknown as ServerAuthShape;

const fakeAutomationService = {
  create: (input: AutomationCreateInput) => {
    createdInputs.push(input);
    if (createFailure) return Effect.fail(createFailure);
    return Effect.succeed({ id: AutomationId.makeUnsafe("automation:task-api-test") });
  },
  runNow: (input: { readonly automationId: string }) => {
    runNowInputs.push(input);
    return Effect.succeed({ run: makeRun() });
  },
  list: (input?: unknown) => {
    listInputs.push(input);
    return Effect.succeed(listResult);
  },
} as unknown as AutomationServiceShape;

const fakeAutomationRepository = {
  getRunById: () => Effect.succeed(runById),
} as unknown as AutomationRepositoryShape;

const fakeProjectionSnapshotQuery = {
  getProjectShellById: () => Effect.succeed(projectShell),
  getThreadShellById: () =>
    Effect.succeed(
      Option.some({ id: threadId, lastKnownPr } as unknown as Record<string, unknown>),
    ),
} as unknown as ProjectionSnapshotQueryShape;

const fakePendingApprovals = {
  listByThreadId: () => Effect.succeed(pendingApprovalRows),
} as unknown as ProjectionPendingApprovalRepositoryShape;

const fakeEventStore = {
  readFromSequence: (sequenceExclusive: number, limit?: number) =>
    Stream.fromArray(
      storedEvents
        .filter((event) => event.sequence > sequenceExclusive)
        .slice(0, limit ?? storedEvents.length),
    ),
} as unknown as OrchestrationEventStoreShape;

const fakeOrchestrationEngine = {
  dispatch: (command: OrchestrationCommand) => {
    dispatchedCommands.push(command);
    return Effect.succeed({ sequence: 1 });
  },
} as unknown as OrchestrationEngineShape;

const fakeRuntimeStartup = {
  enqueueCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
} as unknown as typeof ServerRuntimeStartup.Service;

async function withRunningTransport(run: (origin: string) => Promise<void>): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(taskApiRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerAuth, fakeServerAuth),
              Layer.succeed(AutomationService, fakeAutomationService),
              Layer.succeed(AutomationRepository, fakeAutomationRepository),
              Layer.succeed(ProjectionSnapshotQuery, fakeProjectionSnapshotQuery),
              Layer.succeed(ProjectionPendingApprovalRepository, fakePendingApprovals),
              Layer.succeed(OrchestrationEventStore, fakeEventStore),
              Layer.succeed(OrchestrationEngineService, fakeOrchestrationEngine),
              Layer.succeed(ServerRuntimeStartup, fakeRuntimeStartup),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected effect server to expose an address");
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

function authorizedInit(body?: unknown): RequestInit {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

// ---------------------------------------------------------------------------
// Event fixtures
// ---------------------------------------------------------------------------

function eventBase(sequence: number, aggregateId: ThreadId) {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread" as const,
    aggregateId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

function assistantMessageEvent(
  sequence: number,
  text: string,
  options: { readonly streaming?: boolean; readonly threadId?: ThreadId } = {},
): OrchestrationEvent {
  const target = options.threadId ?? threadId;
  return {
    ...eventBase(sequence, target),
    type: "thread.message-sent",
    payload: {
      threadId: target,
      messageId: MessageId.makeUnsafe(`message-${sequence}`),
      role: "assistant",
      text,
      turnId: TurnId.makeUnsafe("turn-1"),
      streaming: options.streaming ?? false,
      source: "native",
      createdAt: now,
      updatedAt: now,
    },
  };
}

function seedEventFixtures(approvalId: ApprovalRequestId) {
  const pr: OrchestrationThreadPullRequest = {
    number: 7,
    title: "Task PR",
    url: "https://github.com/example/repo/pull/7",
    baseBranch: "main",
    headBranch: "task-branch",
    state: "open",
  };
  storedEvents = [
    assistantMessageEvent(1, "streaming token", { streaming: true }),
    assistantMessageEvent(2, "All done."),
    {
      ...eventBase(3, threadId),
      type: "thread.activity-appended",
      metadata: { requestId: approvalId },
      payload: {
        threadId,
        activity: {
          id: EventId.makeUnsafe("activity-3"),
          tone: "approval",
          kind: "approval-requested",
          summary: "Wants to run: rm -rf node_modules",
          payload: {},
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: now,
        },
      },
    },
    assistantMessageEvent(4, "Other thread noise.", { threadId: otherThreadId }),
    {
      ...eventBase(5, threadId),
      type: "thread.turn-diff-completed",
      payload: {
        threadId,
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [{ path: "src/a.ts", kind: "modified", additions: 5, deletions: 2 }],
        assistantMessageId: null,
        completedAt: now,
      },
    },
    {
      ...eventBase(6, threadId),
      type: "thread.meta-updated",
      payload: { threadId, lastKnownPr: pr, updatedAt: now },
    },
  ];
  return pr;
}

// ---------------------------------------------------------------------------

describe("taskApiRouteLayer", () => {
  afterEach(() => {
    resetHarness();
  });

  describe("auth", () => {
    it.each([
      ["POST /api/tasks", "/api/tasks", { method: "POST" }],
      ["GET /api/tasks", "/api/tasks?name=x", { method: "GET" }],
      [`GET /api/tasks/:id/events`, `/api/tasks/${runId}/events`, { method: "GET" }],
      [`POST /api/tasks/:id/input`, `/api/tasks/${runId}/input`, { method: "POST" }],
    ])("rejects %s without a bearer token", async (_label, path, init) => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(origin + path, init);
        expect(response.status).toBe(401);
      });
    });

    it("rejects an unknown bearer token", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(`${origin}/api/tasks`, {
          method: "POST",
          headers: { authorization: "Bearer not-a-real-token" },
        });
        expect(response.status).toBe(401);
      });
    });
  });

  describe("POST /api/tasks", () => {
    it("creates a standalone manual automation and runs it immediately", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks`,
          authorizedInit({ projectId, prompt: "Fix the flaky login test" }),
        );
        expect(response.status).toBe(201);
        const json = await response.json();
        expect(json).toEqual({ taskId: runId, threadId, status: "running" });

        expect(createdInputs).toHaveLength(1);
        const created = createdInputs[0]!;
        expect(created.projectId).toBe(projectId);
        expect(created.prompt).toBe("Fix the flaky login test");
        expect(created.name).toBe("Fix the flaky login test");
        expect(created.schedule).toEqual({ type: "manual" });
        expect(created.mode).toBe("standalone");
        // Falls back to the project's default model selection.
        expect(created.modelSelection).toEqual({ provider: "codex", model: "gpt-5-codex" });
        expect(runNowInputs).toEqual([{ automationId: "automation:task-api-test" }]);
      });
    });

    it("honors explicit modelSelection/worktreeMode/runtimeMode knobs", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks`,
          authorizedInit({
            projectId,
            prompt: "Refactor the config module",
            modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
            worktreeMode: "worktree",
            runtimeMode: "full-access",
            acknowledgedRisks: ["full-access"],
          }),
        );
        expect(response.status).toBe(201);
        const created = createdInputs[0]!;
        expect(created.modelSelection).toEqual({
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        });
        expect(created.worktreeMode).toBe("worktree");
        expect(created.runtimeMode).toBe("full-access");
        expect(created.acknowledgedRisks).toEqual(["full-access"]);
      });
    });

    it("honors baseBranch onto the created automation definition", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks`,
          authorizedInit({
            projectId,
            prompt: "Fix the login flow",
            baseBranch: "main",
          }),
        );
        expect(response.status).toBe(201);
        const created = createdInputs[0]!;
        expect(created.baseBranch).toBe("main");
      });
    });

    it("defaults baseBranch to null when omitted (legacy checked-out-branch behavior)", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks`,
          authorizedInit({ projectId, prompt: "No pinned base" }),
        );
        expect(response.status).toBe(201);
        expect(createdInputs[0]!.baseBranch ?? null).toBeNull();
      });
    });

    it("appends the PR delivery instruction when deliverPr is set", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks`,
          authorizedInit({ projectId, prompt: "Ship the fix", deliverPr: true }),
        );
        expect(response.status).toBe(201);
        const created = createdInputs[0]!;
        expect(created.prompt).toContain("Ship the fix");
        expect(created.prompt).toContain("open a pull request");
        // The derived task name comes from the original prompt, not the suffix.
        expect(created.name).toBe("Ship the fix");
      });
    });

    it("rejects an unknown projectId with 404", async () => {
      resetHarness();
      projectShell = Option.none();
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks`,
          authorizedInit({ projectId: "no-such-project", prompt: "hello" }),
        );
        expect(response.status).toBe(404);
        expect(createdInputs).toHaveLength(0);
      });
    });

    it("rejects a task without modelSelection when the project has no default", async () => {
      resetHarness();
      projectShell = Option.some({ ...project, defaultModelSelection: null });
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks`,
          authorizedInit({ projectId, prompt: "hello" }),
        );
        expect(response.status).toBe(400);
        expect(createdInputs).toHaveLength(0);
      });
    });

    it("rejects an invalid body with 400", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const missingPrompt = await fetch(`${origin}/api/tasks`, authorizedInit({ projectId }));
        expect(missingPrompt.status).toBe(400);

        const malformed = await fetch(`${origin}/api/tasks`, {
          ...authorizedInit({}),
          body: "{not json",
        });
        expect(malformed.status).toBe(400);
        expect(createdInputs).toHaveLength(0);
      });
    });

    it("maps an AutomationService validation failure to 400", async () => {
      resetHarness();
      createFailure = new AutomationServiceError({
        message: "Enable full access requires acknowledging the risk.",
      });
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks`,
          authorizedInit({ projectId, prompt: "hello" }),
        );
        expect(response.status).toBe(400);
        const json = (await response.json()) as { error: string };
        expect(json.error).toContain("full access");
      });
    });
  });

  describe("GET /api/tasks (lookup by name)", () => {
    /** Minimal definition fixture — the route reads only `id` and `name`. */
    function makeDefinition(id: string, name: string): AutomationDefinition {
      return { id: AutomationId.makeUnsafe(id), name } as unknown as AutomationDefinition;
    }

    it("requires the name query parameter", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(`${origin}/api/tasks`, authorizedInit());
        expect(response.status).toBe(400);
        const json = (await response.json()) as { error: string };
        expect(json.error).toContain("name");
      });
    });

    it("returns runs of exact-name definitions newest-first and skips other names", async () => {
      resetHarness();
      const matchingA = makeDefinition("automation:match-a", "task:thread-1:turn-2");
      const matchingB = makeDefinition("automation:match-b", "task:thread-1:turn-2");
      const other = makeDefinition("automation:other", "task:thread-9:turn-9");
      const olderRun = makeRun({
        id: AutomationRunId.makeUnsafe("automation-run:older"),
        automationId: matchingA.id,
        status: "succeeded",
        createdAt: "2026-07-03T09:00:00.000Z",
        finishedAt: "2026-07-03T09:05:00.000Z",
      });
      const newerRun = makeRun({
        id: AutomationRunId.makeUnsafe("automation-run:newer"),
        automationId: matchingB.id,
        createdAt: "2026-07-03T11:00:00.000Z",
      });
      const unrelatedRun = makeRun({
        id: AutomationRunId.makeUnsafe("automation-run:unrelated"),
        automationId: other.id,
      });
      listResult = {
        definitions: [matchingA, matchingB, other],
        runs: [olderRun, unrelatedRun, newerRun],
      };
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks?name=${encodeURIComponent("task:thread-1:turn-2")}`,
          authorizedInit(),
        );
        expect(response.status).toBe(200);
        const json = (await response.json()) as {
          tasks: ReadonlyArray<{ taskId: string; status: string; name: string }>;
        };
        expect(json.tasks.map((task) => task.taskId)).toEqual([
          "automation-run:newer",
          "automation-run:older",
        ]);
        expect(json.tasks[0]).toEqual({
          taskId: "automation-run:newer",
          threadId,
          status: "running",
          name: "task:thread-1:turn-2",
          projectId,
          createdAt: "2026-07-03T11:00:00.000Z",
          startedAt: now,
          finishedAt: null,
        });
        // Unfiltered list call (no projectId given).
        expect(listInputs).toEqual([{}]);
      });
    });

    it("scopes the lookup with the optional projectId filter", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks?name=nothing-here&projectId=${projectId}`,
          authorizedInit(),
        );
        expect(response.status).toBe(200);
        const json = (await response.json()) as { tasks: ReadonlyArray<unknown> };
        expect(json.tasks).toEqual([]);
        expect(listInputs).toEqual([{ projectId }]);
      });
    });
  });

  describe("GET /api/tasks/:id/events", () => {
    it("returns 404 for an unknown task id", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const response = await fetch(`${origin}/api/tasks/nope/events`, authorizedInit());
        expect(response.status).toBe(404);
      });
    });

    it("projects thread events onto the external union with a monotonic cursor", async () => {
      resetHarness();
      const approvalId = "approval-request-1" as ApprovalRequestId;
      const pr = seedEventFixtures(approvalId);
      runById = Option.some(makeRun({ status: "waiting-for-approval" }));
      lastKnownPr = pr;
      pendingApprovalRows = [
        {
          requestId: approvalId,
          threadId,
          turnId: TurnId.makeUnsafe("turn-1"),
          status: "pending",
          decision: null,
          createdAt: now,
          resolvedAt: null,
        } as ProjectionPendingApproval,
      ];

      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/events?after=0`,
          authorizedInit(),
        );
        expect(response.status).toBe(200);
        const json = (await response.json()) as {
          taskId: string;
          threadId: string;
          run: { status: string; error: string | null; result: unknown };
          lastKnownPr: OrchestrationThreadPullRequest | null;
          pendingApprovals: ReadonlyArray<{ approvalId: string }>;
          events: ReadonlyArray<{ type: string; sequence: number }>;
          nextCursor: number;
        };

        expect(json.taskId).toBe(runId);
        expect(json.threadId).toBe(threadId);
        expect(json.run.status).toBe("waiting-for-approval");
        expect(json.lastKnownPr).toEqual(pr);
        expect(json.pendingApprovals).toEqual([{ approvalId, turnId: "turn-1", createdAt: now }]);
        // Streaming deltas (seq 1) and the other thread's event (seq 4) are
        // dropped; the cursor still advances past everything scanned.
        expect(json.events.map((event) => [event.type, event.sequence])).toEqual([
          ["assistant-message", 2],
          ["activity", 3],
          ["turn-diff", 5],
          ["pr-updated", 6],
        ]);
        expect(json.nextCursor).toBe(6);
        const activity = json.events[1] as { approvalId?: string; tone?: string };
        expect(activity.tone).toBe("approval");
        expect(activity.approvalId).toBe(approvalId);

        // Replaying from the cursor yields no events and a stable cursor.
        const replay = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/events?after=6`,
          authorizedInit(),
        );
        const replayJson = (await replay.json()) as { events: unknown[]; nextCursor: number };
        expect(replayJson.events).toEqual([]);
        expect(replayJson.nextCursor).toBe(6);
      });
    });

    it("includes the terminal run snapshot", async () => {
      resetHarness();
      runById = Option.some(
        makeRun({
          status: "succeeded",
          finishedAt: now,
          result: {
            outcome: "changed-files",
            summary: "Fixed the flaky test.",
            unread: true,
            archivedAt: null,
          },
        }),
      );
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/events`,
          authorizedInit(),
        );
        const json = (await response.json()) as {
          run: { status: string; result: { outcome: string; summary: string } };
        };
        expect(json.run.status).toBe("succeeded");
        expect(json.run.result.outcome).toBe("changed-files");
        expect(json.run.result.summary).toBe("Fixed the flaky test.");
      });
    });
  });

  describe("POST /api/tasks/:id/input", () => {
    it("maps an approval input onto thread.approval.respond", async () => {
      resetHarness();
      runById = Option.some(makeRun({ status: "waiting-for-approval" }));
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/input`,
          authorizedInit({
            type: "approval",
            approvalId: "approval-request-1",
            decision: "accept",
          }),
        );
        expect(response.status).toBe(202);
        expect(dispatchedCommands).toHaveLength(1);
        const command = dispatchedCommands[0]!;
        expect(command.type).toBe("thread.approval.respond");
        if (command.type === "thread.approval.respond") {
          expect(command.threadId).toBe(threadId);
          expect(command.requestId).toBe("approval-request-1");
          expect(command.decision).toBe("accept");
          expect(command.commandId.startsWith("taskapi:")).toBe(true);
        }
        const json = (await response.json()) as { commandId: string };
        expect(json.commandId).toBe(dispatchedCommands[0]!.commandId);
      });
    });

    it("maps a user-input answer onto thread.user-input.respond", async () => {
      resetHarness();
      runById = Option.some(makeRun());
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/input`,
          authorizedInit({
            type: "user-input",
            approvalId: "user-input-1",
            answers: { question: "yes" },
          }),
        );
        expect(response.status).toBe(202);
        const command = dispatchedCommands[0]!;
        expect(command.type).toBe("thread.user-input.respond");
        if (command.type === "thread.user-input.respond") {
          expect(command.requestId).toBe("user-input-1");
          expect(command.answers).toEqual({ question: "yes" });
        }
      });
    });

    it("maps a follow-up message onto thread.turn.start with the run's permission snapshot", async () => {
      resetHarness();
      runById = Option.some(makeRun());
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/input`,
          authorizedInit({ type: "message", text: "Also update the changelog." }),
        );
        expect(response.status).toBe(202);
        const command = dispatchedCommands[0]!;
        expect(command.type).toBe("thread.turn.start");
        if (command.type === "thread.turn.start") {
          expect(command.threadId).toBe(threadId);
          expect(command.message.text).toBe("Also update the changelog.");
          expect(command.message.role).toBe("user");
          expect(command.message.attachments).toEqual([]);
          expect(command.modelSelection).toEqual({ provider: "codex", model: "gpt-5-codex" });
          expect(command.dispatchMode).toBe("queue");
          expect(command.dispatchOrigin).toBe("automation");
          expect(command.runtimeMode).toBe("approval-required");
          expect(command.interactionMode).toBe("default");
        }
      });
    });

    it("mints a fresh commandId per request so HTTP retries are not receipt-deduped", async () => {
      resetHarness();
      runById = Option.some(makeRun());
      await withRunningTransport(async (origin) => {
        const body = { type: "message", text: "again" };
        await fetch(`${origin}/api/tasks/${encodeURIComponent(runId)}/input`, authorizedInit(body));
        await fetch(`${origin}/api/tasks/${encodeURIComponent(runId)}/input`, authorizedInit(body));
        expect(dispatchedCommands).toHaveLength(2);
        expect(dispatchedCommands[0]!.commandId).not.toBe(dispatchedCommands[1]!.commandId);
      });
    });

    it("returns 404 for an unknown task and 409 when the run has no thread", async () => {
      resetHarness();
      await withRunningTransport(async (origin) => {
        const unknown = await fetch(
          `${origin}/api/tasks/nope/input`,
          authorizedInit({ type: "message", text: "hello" }),
        );
        expect(unknown.status).toBe(404);
      });

      runById = Option.some(makeRun({ threadId: null, status: "pending" }));
      await withRunningTransport(async (origin) => {
        const noThread = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/input`,
          authorizedInit({ type: "message", text: "hello" }),
        );
        expect(noThread.status).toBe(409);
        expect(dispatchedCommands).toHaveLength(0);
      });
    });

    it("rejects an invalid input body with 400", async () => {
      resetHarness();
      runById = Option.some(makeRun());
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/input`,
          authorizedInit({ type: "approval" }),
        );
        expect(response.status).toBe(400);
        expect(dispatchedCommands).toHaveLength(0);
      });
    });

    it("returns 404 for an unknown sub-path action", async () => {
      resetHarness();
      runById = Option.some(makeRun());
      await withRunningTransport(async (origin) => {
        const response = await fetch(
          `${origin}/api/tasks/${encodeURIComponent(runId)}/interrupt`,
          authorizedInit({ type: "message", text: "hello" }),
        );
        expect(response.status).toBe(404);
      });
    });
  });
});
