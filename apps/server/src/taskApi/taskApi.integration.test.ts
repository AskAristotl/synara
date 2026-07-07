/**
 * taskApi.integration.test.ts - end-to-end task API over the real stack.
 *
 * Boots the REAL `taskApiRouteLayer` behind a real HTTP listener on top of the
 * REAL `AutomationServiceLive` + REAL `OrchestrationLayerLive` (real engine /
 * decider / projector / projection pipeline on in-memory sqlite, the same
 * composition `subagentMcp/crossModel.integration.test.ts` uses). Only the
 * leaves are test doubles: `ServerAuth` (one known bearer), `GitCore`
 * (non-repo status, no real git), `TextGeneration` (unused — completion
 * policy stays `none`), and `ServerRuntimeStartup` (pass-through queue).
 *
 * Since no provider process runs (`ProviderCommandReactor` is not in this
 * layer), the dispatched turn never produces output on its own. The test
 * drives the thread to a terminal state by dispatching the SAME commands
 * ProviderRuntimeIngestion/CheckpointReactor dispatch for a real finished turn
 * (assistant delta + complete, `thread.turn.diff.complete`,
 * `thread.session.set` idle — mirroring `crossModel.integration.test.ts`'s
 * `completeChildTurn`), then invokes `AutomationService.reconcileThread`
 * directly (the exact call `AutomationRunReactor` makes when it observes those
 * events) and asserts the events endpoint reports the terminal run.
 *
 * @module taskApi.integration.test
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "../auth/Services/ServerAuth.ts";
import { AutomationServiceLive } from "../automation/Layers/AutomationService.ts";
import {
  AutomationService,
  type AutomationServiceShape,
} from "../automation/Services/AutomationService.ts";
import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { GitCore, type GitCoreShape } from "../git/Services/GitCore.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TextGeneration, type TextGenerationShape } from "../git/Services/TextGeneration.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { AutomationRepositoryLive } from "../persistence/Layers/AutomationRepository.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { taskApiRouteLayer } from "./httpTransport.ts";

const VALID_TOKEN = "task-api-integration-bearer";

const fakeServerAuth = {
  authenticateHttpRequest: (request: { readonly headers: Record<string, string | undefined> }) =>
    request.headers.authorization === `Bearer ${VALID_TOKEN}`
      ? Effect.succeed({
          sessionId: "session-1",
          subject: "integration-test",
          method: "bearer",
          role: "client",
        })
      : Effect.fail(new AuthError({ message: "Unauthorized", status: 401 })),
} as unknown as ServerAuthShape;

// Non-repo git status: worktreeMode "auto" resolves the thread to a plain
// local checkout, so no real git ever runs (same shape as the gitCore stub in
// `automation/Layers/AutomationService.test.ts`).
const gitCoreStub = {
  statusDetails: (cwd: string) =>
    Effect.succeed({
      isRepo: false,
      hasOriginRemote: false,
      isDefaultBranch: true,
      branch: null,
      upstreamRef: null,
      upstreamBranch: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      cwd,
    }),
} as unknown as GitCoreShape;

const textGenerationStub = {
  evaluateAutomationCompletion: () => Effect.die(new Error("unused: completion policy is none")),
} as unknown as TextGenerationShape;

const runtimeStartupPassthrough = {
  enqueueCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
} as unknown as typeof ServerRuntimeStartup.Service;

interface IntegrationContext {
  readonly origin: string;
  readonly engine: OrchestrationEngineShape;
  readonly automationService: AutomationServiceShape;
  readonly projection: ProjectionSnapshotQueryShape;
}

async function withIntegrationStack(
  run: (ctx: IntegrationContext) => Promise<void>,
  options: { readonly realGit?: boolean } = {},
) {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-task-api-integration-test-",
  });
  const orchestrationLayer = OrchestrationLayerLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  // realGit: the true GitCore over the same test ServerConfig (worktrees land
  // in the scoped temp baseDir) — used by the baseBranch fixture tests.
  const gitCoreLayer = options.realGit
    ? GitCoreLive.pipe(Layer.provide(serverConfigLayer), Layer.provide(NodeServices.layer))
    : Layer.succeed(GitCore, gitCoreStub);
  const automationLayer = AutomationServiceLive.pipe(
    Layer.provideMerge(AutomationRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(orchestrationLayer),
    Layer.provide(Layer.succeed(TextGeneration, textGenerationStub)),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(gitCoreLayer),
  );
  const fullLayer = Layer.mergeAll(
    automationLayer,
    Layer.succeed(ServerAuth, fakeServerAuth),
    Layer.succeed(ServerRuntimeStartup, runtimeStartupPassthrough),
  );

  // ManagedRuntime keeps the layer (and the engine's background command
  // worker, which is forked into the layer scope) alive across the whole
  // test, mirroring `crossModel.integration.test.ts`.
  const runtime = ManagedRuntime.make(fullLayer);
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    const context = await runtime.runPromise(
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
          return {
            engine: yield* OrchestrationEngineService,
            automationService: yield* AutomationService,
            projection: yield* ProjectionSnapshotQuery,
          };
        }),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected effect server to expose an address");
    }
    await run({ origin: `http://127.0.0.1:${address.port}`, ...context });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  }
}

/**
 * Drive the task's thread through a completed turn exactly as
 * ProviderRuntimeIngestion/CheckpointReactor would for a real finished turn:
 * final assistant text, a turn checkpoint (`thread.turn.diff.complete` is what
 * flips the projected `latestTurn` to `completed` — the state
 * `reconcileThread` derives `succeeded` from), then back to idle.
 */
async function completeTaskTurn(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  finalMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  const turnId = TurnId.makeUnsafe(randomUUID());
  const messageId = MessageId.makeUnsafe(randomUUID());
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.makeUnsafe(`cmd-assistant-delta-${randomUUID()}`),
      threadId,
      messageId,
      delta: finalMessage,
      createdAt: now,
    }),
  );
  // The final (streaming: false) assistant message-sent — the one the task
  // API's events union forwards.
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.makeUnsafe(`cmd-assistant-complete-${randomUUID()}`),
      threadId,
      messageId,
      createdAt: now,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.makeUnsafe(`cmd-turn-diff-${randomUUID()}`),
      threadId,
      turnId,
      completedAt: now,
      checkpointRef: CheckpointRef.makeUnsafe(randomUUID()),
      status: "ready",
      files: [{ path: "src/a.ts", kind: "modified", additions: 5, deletions: 2 }],
      checkpointTurnCount: 1,
      createdAt: now,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`cmd-session-idle-${randomUUID()}`),
      threadId,
      session: {
        threadId,
        status: "idle",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    }),
  );
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

describe("task API end-to-end (real engine + real AutomationService)", () => {
  it("dispatches a task, streams its events, and reports the reconciled terminal run", async () => {
    await withIntegrationStack(async ({ origin, engine, automationService }) => {
      // 1. Seed a real project through the engine (projects are only created
      // by the `project.create` orchestration command; see the ws RPC).
      const projectId = ProjectId.makeUnsafe(randomUUID());
      await Effect.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(`cmd-project-create-${randomUUID()}`),
          projectId,
          title: "Task API project",
          workspaceRoot: "/tmp/task-api-integration-project",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: new Date().toISOString(),
        }),
      );

      // 2. POST /api/tasks: real AutomationService.create + runNow, which
      // dispatches real thread.create + thread.turn.start through the engine.
      const createResponse = await fetch(
        `${origin}/api/tasks`,
        authorizedInit({
          projectId,
          prompt: "Summarize the repo layout",
          // The stubbed workspace is not a git repo, so worktreeMode "auto"
          // falls back to a local checkout — which AutomationService requires
          // an explicit risk acknowledgement for.
          acknowledgedRisks: ["local-checkout"],
        }),
      );
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        taskId: string;
        threadId: string;
        status: string;
      };
      expect(created.taskId).toBeTruthy();
      expect(created.threadId).toBeTruthy();
      expect(created.status).toBe("running");
      const threadId = ThreadId.makeUnsafe(created.threadId);
      const eventsPath = `${origin}/api/tasks/${encodeURIComponent(created.taskId)}/events`;

      // 3. The events cursor sees the running turn's real domain events (the
      // dispatched user message) and advances monotonically.
      const firstPoll = await fetch(`${eventsPath}?after=0`, authorizedInit());
      expect(firstPoll.status).toBe(200);
      const firstJson = (await firstPoll.json()) as {
        run: { status: string };
        nextCursor: number;
        events: ReadonlyArray<{ type: string }>;
      };
      expect(firstJson.run.status).toBe("running");
      expect(firstJson.nextCursor).toBeGreaterThan(0);

      // 4. Simulate the provider finishing the turn, then reconcile — the
      // exact call AutomationRunReactor makes when it observes these events.
      await completeTaskTurn(engine, threadId, "The repo is a Bun + Effect monorepo.");
      await Effect.runPromise(automationService.reconcileThread({ threadId }));

      // 5. The events endpoint now reports the terminal run snapshot AND the
      // final assistant message (streaming deltas coalesce into it).
      const finalPoll = await fetch(
        `${eventsPath}?after=${firstJson.nextCursor}`,
        authorizedInit(),
      );
      expect(finalPoll.status).toBe(200);
      const finalJson = (await finalPoll.json()) as {
        run: { status: string; result: { summary: string | null } | null };
        events: ReadonlyArray<{ type: string; text?: string }>;
        nextCursor: number;
      };
      expect(finalJson.run.status).toBe("succeeded");
      expect(finalJson.run.result).not.toBeNull();
      expect(finalJson.nextCursor).toBeGreaterThan(firstJson.nextCursor);
      const assistantMessages = finalJson.events.filter(
        (event) => event.type === "assistant-message",
      );
      expect(assistantMessages.length).toBeGreaterThan(0);
      expect(assistantMessages.at(-1)?.text).toBe("The repo is a Bun + Effect monorepo.");
    });
  });
});

// ---------------------------------------------------------------------------
// baseBranch (real git fixture)
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

/**
 * Upstream repo + workspace clone where origin/main is AHEAD of the clone:
 * commit A is cloned, then commit B lands upstream only. The clone's local
 * `main` (and its stale remote-tracking ref) stay at A — a run worktree at B
 * therefore PROVES dispatch fetched origin.
 */
function makeStaleCloneFixture(root: string): {
  upstream: string;
  workspace: string;
  commitA: string;
  commitB: string;
} {
  const upstream = join(root, "upstream");
  const workspace = join(root, "workspace");
  git(root, "init", "-b", "main", upstream);
  git(upstream, "commit", "--allow-empty", "-m", "A");
  const commitA = git(upstream, "rev-parse", "HEAD");
  git(root, "clone", upstream, workspace);
  git(upstream, "commit", "--allow-empty", "-m", "B");
  const commitB = git(upstream, "rev-parse", "HEAD");
  return { upstream, workspace, commitA, commitB };
}

async function createProjectAndTask(
  ctx: IntegrationContext,
  workspaceRoot: string,
  body: Record<string, unknown>,
): Promise<{ taskId: string; threadId: string; status: string }> {
  const projectId = ProjectId.makeUnsafe(randomUUID());
  await Effect.runPromise(
    ctx.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(`cmd-project-create-${randomUUID()}`),
      projectId,
      title: "Task API baseBranch project",
      workspaceRoot,
      defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      createdAt: new Date().toISOString(),
    }),
  );
  const response = await fetch(`${ctx.origin}/api/tasks`, authorizedInit({ projectId, ...body }));
  expect(response.status).toBe(201);
  return (await response.json()) as { taskId: string; threadId: string; status: string };
}

/** Poll the projected thread shell for its worktree path (projection is engine-async). */
async function threadWorktreePath(ctx: IntegrationContext, threadId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const shellOption = await Effect.runPromise(
      ctx.projection.getThreadShellById(ThreadId.makeUnsafe(threadId)),
    );
    if (Option.isSome(shellOption)) {
      const shell = shellOption.value as { worktreePath: string | null };
      if (shell.worktreePath) {
        return shell.worktreePath;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`thread ${threadId} never projected a worktree path`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("task API baseBranch (real git + real AutomationService)", () => {
  it("fetches origin/<baseBranch> so the run worktree starts from the LATEST origin tip", async () => {
    const root = mkdtempSync(join(tmpdir(), "t3-task-api-basebranch-"));
    try {
      const fixture = makeStaleCloneFixture(root);
      await withIntegrationStack(
        async (ctx) => {
          const created = await createProjectAndTask(ctx, fixture.workspace, {
            prompt: "Start from latest origin main",
            baseBranch: "main",
          });
          expect(created.status).toBe("running");
          const worktree = await threadWorktreePath(ctx, created.threadId);
          // The worktree HEAD is upstream's commit B — which only a fetch
          // could have delivered (the clone's local/remote-tracking main is A).
          expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.commitB);
          expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toContain("automation/");
        },
        { realGit: true },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("without baseBranch keeps today's behavior: branches off the stale checked-out local tip", async () => {
    const root = mkdtempSync(join(tmpdir(), "t3-task-api-basebranch-ctl-"));
    try {
      const fixture = makeStaleCloneFixture(root);
      await withIntegrationStack(
        async (ctx) => {
          const created = await createProjectAndTask(ctx, fixture.workspace, {
            prompt: "Legacy current-branch behavior",
          });
          expect(created.status).toBe("running");
          const worktree = await threadWorktreePath(ctx, created.threadId);
          // No fetch: the run worktree branches from the clone's local main (A),
          // NOT upstream's newer B.
          expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.commitA);
        },
        { realGit: true },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails the run hard when the baseBranch fetch cannot succeed (no silent stale fallback)", async () => {
    const root = mkdtempSync(join(tmpdir(), "t3-task-api-basebranch-err-"));
    try {
      const fixture = makeStaleCloneFixture(root);
      await withIntegrationStack(
        async (ctx) => {
          const projectId = ProjectId.makeUnsafe(randomUUID());
          await Effect.runPromise(
            ctx.engine.dispatch({
              type: "project.create",
              commandId: CommandId.makeUnsafe(`cmd-project-create-${randomUUID()}`),
              projectId,
              title: "Task API baseBranch missing-branch project",
              workspaceRoot: fixture.workspace,
              defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
              createdAt: new Date().toISOString(),
            }),
          );
          const response = await fetch(
            `${ctx.origin}/api/tasks`,
            authorizedInit({
              projectId,
              prompt: "Fetch a branch origin does not have",
              baseBranch: "no-such-branch",
              // Would allow the auto-mode local fallback — baseBranch must
              // still refuse to degrade to the stale local checkout.
              acknowledgedRisks: ["local-checkout"],
            }),
          );
          // runNow surfaces the dispatch failure as an AutomationServiceError → 400.
          expect(response.status).toBe(400);
          const json = (await response.json()) as { error: string };
          expect(json.error).toContain("no-such-branch");
        },
        { realGit: true },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
