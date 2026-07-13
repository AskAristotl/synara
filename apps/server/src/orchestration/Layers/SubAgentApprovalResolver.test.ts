import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type OrchestrationEvent,
  type ProviderApprovalDecision,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { SubAgentApprovalResolver } from "../Services/SubAgentApprovalResolver.ts";
import { OrchestrationLayerLive } from "../runtimeLayer.ts";
import { SubAgentApprovalResolverLive } from "./SubAgentApprovalResolver.ts";

/**
 * Real `OrchestrationLayerLive` (engine + projection pipeline + snapshot
 * query) backed by an in-memory sqlite -- the same composition
 * `SubAgentOrchestrator.test.ts`'s "layer wiring" describe block and
 * `CheckpointReactor.test.ts` use for reactor-harness tests. Dispatching a
 * command through the REAL engine exercises the REAL decider/projector/
 * projection-pipeline path (including this task's new `subagentApproval`
 * column), rather than a hand-rolled fake.
 */
function buildHarness() {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-subagent-approval-resolver-test-",
  });
  const orchestrationLayer = OrchestrationLayerLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const layer = SubAgentApprovalResolverLive.pipe(Layer.provideMerge(orchestrationLayer));
  const runtime = ManagedRuntime.make(layer);
  return { runtime };
}

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

/** Dispatches `project.create` (idempotent per PROJECT_ID) then `thread.create`. */
async function seedThread(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  subagentApproval: "auto" | "ask-human" | "read-only" | null,
) {
  const createdAt = new Date().toISOString();
  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(`cmd-project-create-${randomUUID()}`),
      projectId: PROJECT_ID,
      title: "Test Project",
      workspaceRoot: "/tmp/subagent-approval-resolver-test",
      createdAt,
    }),
  ).catch(() => {
    // project.create is dispatched once per PROJECT_ID; a second thread in
    // the same test reuses the already-created project (thread.create below
    // requires the project to exist, so this must run before it regardless).
  });
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(`cmd-thread-create-${randomUUID()}`),
      threadId,
      projectId: PROJECT_ID,
      title: "Sub-agent thread",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      subagentApproval,
      createdAt,
    }),
  );
}

/** Dispatches `thread.activity.append` with an `approval.requested` activity. */
function appendApprovalRequested(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
) {
  const createdAt = new Date().toISOString();
  return Effect.runPromise(
    engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`cmd-activity-append-${randomUUID()}`),
      threadId,
      activity: {
        id: EventId.makeUnsafe(randomUUID()),
        tone: "approval",
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: { requestId, requestKind: "command", requestType: "command_execution_approval" },
        turnId: null,
        createdAt,
      },
      createdAt,
    }),
  );
}

/** Every persisted domain event so far, in order. */
async function collectEvents(engine: OrchestrationEngineShape): Promise<OrchestrationEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(engine.readEvents(0)));
  return Array.from(chunk);
}

/** The `thread.approval-response-requested` event for a given requestId, if any. */
function approvalResponseEventFor(
  events: readonly OrchestrationEvent[],
  requestId: ApprovalRequestId,
) {
  return events.find(
    (event) =>
      event.type === "thread.approval-response-requested" && event.payload.requestId === requestId,
  ) as Extract<OrchestrationEvent, { type: "thread.approval-response-requested" }> | undefined;
}

/**
 * Polls persisted events (10ms interval) until the resolver's response for
 * `requestId` appears or `timeoutMs` elapses. The resolver reacts to an
 * asynchronously-delivered domain event (its `Stream.runForEach` subscription
 * over `engine.streamDomainEvents`, forked by `start()`), so a single
 * immediate read right after dispatching the triggering `approval.requested`
 * activity is not reliable -- this mirrors the polling helpers
 * (`waitFor`/`waitForEvent`/`waitForThread`) every other reactor test file in
 * this directory (`ProviderCommandReactor.test.ts`, `CheckpointReactor.test.ts`)
 * already uses for the same reason.
 */
async function waitForResponseDecision(
  engine: OrchestrationEngineShape,
  requestId: ApprovalRequestId,
  timeoutMs = 2000,
): Promise<ProviderApprovalDecision | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const responseEvent = approvalResponseEventFor(await collectEvents(engine), requestId);
    if (responseEvent) {
      return responseEvent.payload.decision;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Polls persisted events (10ms interval) for `windowMs`, failing the moment a
 * response for `requestId` appears. A generous window relative to the
 * in-memory sqlite round-trips involved makes an absence observed throughout
 * it a reliable "never responded" signal, not a race with the resolver's
 * subscription warming up.
 */
async function assertNeverResponds(
  engine: OrchestrationEngineShape,
  requestId: ApprovalRequestId,
  windowMs = 500,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const responseEvent = approvalResponseEventFor(await collectEvents(engine), requestId);
    if (responseEvent) {
      throw new Error(
        `expected no auto-response for requestId '${requestId}', but got decision '${responseEvent.payload.decision}'`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("SubAgentApprovalResolver", () => {
  it("auto-accepts an approval request for a subagentApproval:'auto' thread", async () => {
    const { runtime } = buildHarness();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const resolver = await runtime.runPromise(Effect.service(SubAgentApprovalResolver));
      await Effect.runPromise(resolver.start().pipe(Scope.provide(scope)));

      const threadId = ThreadId.makeUnsafe(randomUUID());
      await seedThread(engine, threadId, "auto");
      const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      await appendApprovalRequested(engine, threadId, requestId);

      const decision = await waitForResponseDecision(engine, requestId);
      expect(decision).toBe("accept");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("auto-declines an approval request for a subagentApproval:'read-only' thread", async () => {
    const { runtime } = buildHarness();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const resolver = await runtime.runPromise(Effect.service(SubAgentApprovalResolver));
      await Effect.runPromise(resolver.start().pipe(Scope.provide(scope)));

      const threadId = ThreadId.makeUnsafe(randomUUID());
      await seedThread(engine, threadId, "read-only");
      const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      await appendApprovalRequested(engine, threadId, requestId);

      const decision = await waitForResponseDecision(engine, requestId);
      expect(decision).toBe("decline");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("does not auto-respond for a subagentApproval:'ask-human' thread", async () => {
    const { runtime } = buildHarness();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const resolver = await runtime.runPromise(Effect.service(SubAgentApprovalResolver));
      await Effect.runPromise(resolver.start().pipe(Scope.provide(scope)));

      const threadId = ThreadId.makeUnsafe(randomUUID());
      await seedThread(engine, threadId, "ask-human");
      const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      await appendApprovalRequested(engine, threadId, requestId);

      await assertNeverResponds(engine, requestId);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("does not auto-respond for a non-sub-agent thread (subagentApproval:null) -- a human handles it as today", async () => {
    const { runtime } = buildHarness();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const resolver = await runtime.runPromise(Effect.service(SubAgentApprovalResolver));
      await Effect.runPromise(resolver.start().pipe(Scope.provide(scope)));

      const threadId = ThreadId.makeUnsafe(randomUUID());
      await seedThread(engine, threadId, null);
      const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      await appendApprovalRequested(engine, threadId, requestId);

      await assertNeverResponds(engine, requestId);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });
});
