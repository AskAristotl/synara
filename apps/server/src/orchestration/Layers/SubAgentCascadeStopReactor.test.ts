import { randomUUID } from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { describe, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../../provider/Services/ProviderDiscoveryService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { SubAgentCascadeStopReactor } from "../Services/SubAgentCascadeStopReactor.ts";
import { OrchestrationLayerLive } from "../runtimeLayer.ts";
import { SubAgentCascadeStopReactorLive } from "./SubAgentCascadeStopReactor.ts";
import { SubAgentOrchestratorLive } from "./SubAgentOrchestrator.ts";

/**
 * `SubAgentOrchestratorLive` requires `ProviderDiscoveryService`/`GitCore`
 * unconditionally at layer-build time (spawn's dependencies), even though
 * this reactor only ever calls `cascadeStopChildren`/`stop` (which touch
 * neither). Both are `Effect.die` stubs -- mirrors `SubAgentOrchestrator.test.ts`'s
 * `createDiscoveryStub`/`createGitCoreStub` unused members.
 */
function unusedDiscoveryStub(): ProviderDiscoveryServiceShape {
  const unused = () => Effect.die(new Error("provider discovery method unused in test"));
  return {
    getComposerCapabilities: unused,
    listCommands: unused,
    listSkills: unused,
    listPlugins: unused,
    readPlugin: unused,
    listModels: unused,
    listAgents: unused,
  };
}

function unusedGitCoreStub(): GitCoreShape {
  const unused = () => Effect.die(new Error("GitCore method unused in test"));
  return {
    createWorktree: unused,
    snapshotWorkingTree: unused,
  } as unknown as GitCoreShape;
}

/**
 * Real `OrchestrationLayerLive` (engine + projection pipeline + snapshot
 * query) backed by an in-memory sqlite, with a real `SubAgentOrchestratorLive`
 * (stubbed discovery/GitCore -- never exercised here) underneath the reactor
 * under test. Dispatching a command through the REAL engine exercises the
 * REAL decider/projector/projection-pipeline/`ProviderCommandReactor`-adjacent
 * `thread.session-stop-requested` path this reactor reacts to, mirroring
 * `SubAgentApprovalResolver.test.ts`'s harness for the sibling reactor.
 */
function buildHarness() {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-subagent-cascade-stop-reactor-test-",
  });
  const orchestrationLayer = OrchestrationLayerLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const subAgentOrchestratorLayer = SubAgentOrchestratorLive.pipe(
    Layer.provide(Layer.succeed(ProviderDiscoveryService, unusedDiscoveryStub())),
    Layer.provide(Layer.succeed(GitCore, unusedGitCoreStub())),
    Layer.provideMerge(orchestrationLayer),
  );
  const layer = SubAgentCascadeStopReactorLive.pipe(Layer.provideMerge(subAgentOrchestratorLayer));
  const runtime = ManagedRuntime.make(layer);
  return { runtime };
}

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

/** Dispatches `project.create` (idempotent per PROJECT_ID) then `thread.create`. */
async function seedThread(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  parentThreadId: ThreadId | null,
) {
  const createdAt = new Date().toISOString();
  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(`cmd-project-create-${randomUUID()}`),
      projectId: PROJECT_ID,
      title: "Test Project",
      workspaceRoot: "/tmp/subagent-cascade-stop-reactor-test",
      createdAt,
    }),
  ).catch(() => {
    // project.create is dispatched once per PROJECT_ID; a second/third thread
    // in the same test reuses the already-created project.
  });
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(`cmd-thread-create-${randomUUID()}`),
      threadId,
      projectId: PROJECT_ID,
      title: "Test thread",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      ...(parentThreadId !== null ? { parentThreadId, subagentAgentId: threadId } : {}),
      createdAt,
    }),
  );
}

/** Dispatches `thread.session.set`, putting `threadId`'s session at `status`. */
function setSessionStatus(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  status: "idle" | "starting" | "running" | "ready" | "stopped" | "error" | "interrupted",
) {
  const createdAt = new Date().toISOString();
  return Effect.runPromise(
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`cmd-session-set-${randomUUID()}`),
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    }),
  );
}

/** Dispatches `thread.session.stop` for `threadId`. */
function dispatchSessionStop(engine: OrchestrationEngineShape, threadId: ThreadId) {
  const createdAt = new Date().toISOString();
  return Effect.runPromise(
    engine.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.makeUnsafe(`cmd-session-stop-${randomUUID()}`),
      threadId,
      createdAt,
    }),
  );
}

/** Every persisted domain event so far, in order. */
async function collectEvents(engine: OrchestrationEngineShape): Promise<OrchestrationEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(engine.readEvents(0)));
  return Array.from(chunk);
}

/** Count of persisted `thread.session-stop-requested` events for `threadId`. */
async function countSessionStopRequestedEvents(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
): Promise<number> {
  const events = await collectEvents(engine);
  return events.filter(
    (event) =>
      event.type === "thread.session-stop-requested" && event.payload.threadId === threadId,
  ).length;
}

/**
 * Polls (10ms interval) until at least `expectedCount` persisted
 * `thread.session-stop-requested` events exist for `threadId`, or
 * `timeoutMs` elapses. This reactor's only observable effect (short of
 * running the separate `ProviderCommandReactor`, out of scope for THIS
 * reactor's own unit test -- see `SubAgentOrchestrator.ts`'s `stop` doc
 * comment) is the `thread.session.stop` command it dispatches for each live
 * child, which the decider turns directly into this event -- so polling for
 * the event (not projected session status, which only
 * `ProviderCommandReactor` ever sets) is the correct, decoupled signal here.
 * Mirrors the polling helpers every other reactor test file in this
 * directory (`SubAgentApprovalResolver.test.ts`, `ProviderCommandReactor.test.ts`)
 * already uses for the same async-domain-event-driven-effect reason.
 */
async function waitForSessionStopRequestedCount(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  expectedCount: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await countSessionStopRequestedEvents(engine, threadId);
    if (count >= expectedCount) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${expectedCount} thread.session-stop-requested event(s) for thread '${threadId}', saw ${count}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Polls for `windowMs`, asserting the count of persisted
 * `thread.session-stop-requested` events for `threadId` never exceeds
 * `expectedCount` -- a reliable "never (re-)stopped" signal given the
 * generous window relative to the in-memory sqlite round-trips involved.
 */
async function assertStopRequestedEventCountStaysAt(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  expectedCount: number,
  windowMs = 500,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const count = await countSessionStopRequestedEvents(engine, threadId);
    if (count !== expectedCount) {
      throw new Error(
        `expected thread.session-stop-requested count for '${threadId}' to stay at ${expectedCount}, got ${count}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("SubAgentCascadeStopReactor", () => {
  it("cascades stop to a parent's live children when the parent's session is stopped", async () => {
    const { runtime } = buildHarness();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const reactor = await runtime.runPromise(Effect.service(SubAgentCascadeStopReactor));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

      const parentThreadId = ThreadId.makeUnsafe(randomUUID());
      const childAThreadId = ThreadId.makeUnsafe(randomUUID());
      const childBThreadId = ThreadId.makeUnsafe(randomUUID());
      await seedThread(engine, parentThreadId, null);
      await seedThread(engine, childAThreadId, parentThreadId);
      await seedThread(engine, childBThreadId, parentThreadId);
      // LIVE sessions (Task 5.2's isLiveChildSession set): "running" and
      // "idle" both count, exercising more than just the "running" member.
      await setSessionStatus(engine, childAThreadId, "running");
      await setSessionStatus(engine, childBThreadId, "idle");

      await dispatchSessionStop(engine, parentThreadId);

      // Both live children get their own thread.session.stop dispatched by
      // cascadeStopChildren, each producing its own
      // thread.session-stop-requested event.
      await waitForSessionStopRequestedCount(engine, childAThreadId, 1);
      await waitForSessionStopRequestedCount(engine, childBThreadId, 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("does not cascade stop to a child of a DIFFERENT parent", async () => {
    const { runtime } = buildHarness();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const reactor = await runtime.runPromise(Effect.service(SubAgentCascadeStopReactor));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

      const parentThreadId = ThreadId.makeUnsafe(randomUUID());
      const otherParentThreadId = ThreadId.makeUnsafe(randomUUID());
      const otherChildThreadId = ThreadId.makeUnsafe(randomUUID());
      await seedThread(engine, parentThreadId, null);
      await seedThread(engine, otherParentThreadId, null);
      await seedThread(engine, otherChildThreadId, otherParentThreadId);
      await setSessionStatus(engine, otherChildThreadId, "running");

      await dispatchSessionStop(engine, parentThreadId);
      // Confirms the reactor actually processed the parent's own stop
      // (the direct event from our dispatch above) before asserting absence.
      await waitForSessionStopRequestedCount(engine, parentThreadId, 1);

      // The unrelated child never gets a thread.session-stop-requested event.
      await assertStopRequestedEventCountStaysAt(engine, otherChildThreadId, 0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("does nothing (no crash, no stray events) when stopping a childless thread", async () => {
    const { runtime } = buildHarness();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const reactor = await runtime.runPromise(Effect.service(SubAgentCascadeStopReactor));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

      const threadId = ThreadId.makeUnsafe(randomUUID());
      await seedThread(engine, threadId, null);
      await setSessionStatus(engine, threadId, "running");

      await dispatchSessionStop(engine, threadId);
      await waitForSessionStopRequestedCount(engine, threadId, 1);

      // Exactly the one direct stop event for the childless thread itself --
      // cascading found no children and produced no further commands/events.
      await assertStopRequestedEventCountStaysAt(engine, threadId, 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("does not re-stop a child whose session is already terminal (stopped) when the parent is stopped", async () => {
    const { runtime } = buildHarness();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const reactor = await runtime.runPromise(Effect.service(SubAgentCascadeStopReactor));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

      const parentThreadId = ThreadId.makeUnsafe(randomUUID());
      const liveChildThreadId = ThreadId.makeUnsafe(randomUUID());
      const alreadyStoppedChildThreadId = ThreadId.makeUnsafe(randomUUID());
      await seedThread(engine, parentThreadId, null);
      await seedThread(engine, liveChildThreadId, parentThreadId);
      await seedThread(engine, alreadyStoppedChildThreadId, parentThreadId);
      await setSessionStatus(engine, liveChildThreadId, "running");
      // Simulates a child that already reached a terminal session before the
      // parent-level stop -- e.g. it finished on its own, or was stopped
      // independently earlier. cascadeStopChildren's live-child filter
      // (isLiveChildSession) is read fresh off the projection at cascade
      // time, so this directly-set terminal status is what it will see.
      await setSessionStatus(engine, alreadyStoppedChildThreadId, "stopped");

      await dispatchSessionStop(engine, parentThreadId);

      // The live child gets stopped...
      await waitForSessionStopRequestedCount(engine, liveChildThreadId, 1);
      // ...but the already-terminal child is never touched at all.
      await assertStopRequestedEventCountStaysAt(engine, alreadyStoppedChildThreadId, 0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });
});
