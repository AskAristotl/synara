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
import { randomUUID } from "node:crypto";
import http from "node:http";

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
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "../auth/Services/ServerAuth.ts";
import { AutomationServiceLive } from "../automation/Layers/AutomationService.ts";
import {
  AutomationService,
  type AutomationServiceShape,
} from "../automation/Services/AutomationService.ts";
import { ServerConfig } from "../config.ts";
import { GitCore, type GitCoreShape } from "../git/Services/GitCore.ts";
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
}

async function withIntegrationStack(run: (ctx: IntegrationContext) => Promise<void>) {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-task-api-integration-test-",
  });
  const orchestrationLayer = OrchestrationLayerLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const automationLayer = AutomationServiceLive.pipe(
    Layer.provideMerge(AutomationRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(orchestrationLayer),
    Layer.provide(Layer.succeed(TextGeneration, textGenerationStub)),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(Layer.succeed(GitCore, gitCoreStub)),
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
