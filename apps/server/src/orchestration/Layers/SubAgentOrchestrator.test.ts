import { randomUUID } from "node:crypto";

import {
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  OrchestrationThread,
  ProjectId,
  type ProviderComposerCapabilities,
  SubAgentSpawnInput,
  SubAgentWaitInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";
import { Effect, Layer, ManagedRuntime, Option, Queue, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderUnsupportedError } from "../../provider/Errors.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../../provider/Services/ProviderDiscoveryService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  SubAgentError,
  SubAgentOrchestrator,
  type SubAgentSpawnCaller,
} from "../Services/SubAgentOrchestrator.ts";
import { SubAgentOrchestratorLive } from "./SubAgentOrchestrator.ts";

const decodeSpawnInput = Schema.decodeUnknownSync(SubAgentSpawnInput);
const decodeWaitInput = Schema.decodeUnknownSync(SubAgentWaitInput);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);

/**
 * A ProjectionSnapshotQuery test double backed by a mutable thread map. Only
 * `getThreadDetailById` is meaningful — `wait` reads each child's envelope/state
 * through it; the rest are inert (mirrors how the discovery/engine doubles stub
 * out unused members).
 */
function createProjectionStub(
  threads: ReadonlyMap<string, OrchestrationThread>,
): ProjectionSnapshotQueryShape {
  const unused = () => Effect.die(new Error("projection snapshot method unused in test"));
  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    Effect.sync(() => {
      const thread = threads.get(threadId);
      return thread ? Option.some(thread) : Option.none();
    });
  return {
    getCommandReadModel: unused,
    getSnapshot: unused,
    getCounts: unused,
    getSnapshotSequence: unused,
    getShellSnapshot: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShellById: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getThreadCheckpointContext: unused,
    getFullThreadDiffContext: unused,
    getThreadShellById: unused,
    findSyntheticSubagentParentThread: unused,
    getThreadDetailById,
    getThreadDetailSnapshotById: unused,
  };
}

const NOW = new Date("2026-06-30T00:00:00.000Z").getTime();
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

type SessionStub = {
  readonly status: string;
  readonly activeTurnId?: string | null;
  readonly lastError?: string | null;
};

function makeSession(threadId: ThreadId, session: SessionStub) {
  return {
    threadId,
    status: session.status,
    providerName: "codex",
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    updatedAt: iso(0),
  };
}

function makeThread(opts: {
  readonly id: ThreadId;
  readonly provider?: string;
  readonly model?: string;
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly session: ReturnType<typeof makeSession> | null;
  readonly latestTurnState?: "running" | "completed" | "interrupted" | "error" | null;
}): OrchestrationThread {
  const messages = (opts.messages ?? []).map((message, index) => ({
    id: MessageId.makeUnsafe(randomUUID()),
    role: message.role,
    text: message.text,
    turnId: null,
    streaming: false,
    createdAt: iso(index * 1000),
    updatedAt: iso(index * 1000),
  }));
  const latestTurn = opts.latestTurnState
    ? {
        turnId: TurnId.makeUnsafe(randomUUID()),
        state: opts.latestTurnState,
        requestedAt: iso(0),
        startedAt: iso(0),
        completedAt: opts.latestTurnState === "completed" ? iso(0) : null,
        assistantMessageId: null,
      }
    : null;
  return decodeThread({
    id: opts.id,
    projectId: ProjectId.makeUnsafe(randomUUID()),
    title: "child sub-agent",
    modelSelection: { provider: opts.provider ?? "codex", model: opts.model ?? "gpt-5-codex" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn,
    createdAt: iso(0),
    updatedAt: iso(0),
    deletedAt: null,
    messages,
    activities: [],
    checkpoints: [],
    session: opts.session,
  });
}

/**
 * Minimal domain events for the two signals `wait` consumes. Cast to
 * OrchestrationEvent (the consumer only reads `type` + `payload.threadId` /
 * `payload.session`), mirroring the cast-event style of the runtime-ingestion
 * harness.
 */
function sessionSetEvent(
  threadId: ThreadId,
  session: ReturnType<typeof makeSession>,
): OrchestrationEvent {
  return {
    type: "thread.session-set",
    payload: { threadId, session },
  } as unknown as OrchestrationEvent;
}
function turnDiffCompletedEvent(threadId: ThreadId): OrchestrationEvent {
  return {
    type: "thread.turn-diff-completed",
    payload: { threadId },
  } as unknown as OrchestrationEvent;
}

/**
 * Harness for `wait`: a recording engine whose `streamDomainEvents` is backed by
 * an unbounded Queue the test can push into (retained delivery to the single
 * `wait` consumer keeps the test deterministic regardless of subscribe timing),
 * plus a mutable thread map behind ProjectionSnapshotQuery.
 */
function buildWaitHarness() {
  const eventQueue = Effect.runSync(Queue.unbounded<OrchestrationEvent>());
  const threads = new Map<string, OrchestrationThread>();
  const engine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    getReadModel: () => Effect.die(new Error("getReadModel unused in test")),
    dispatch: () => Effect.die(new Error("dispatch unused in wait test")),
    repairState: () => Effect.die(new Error("repairState unused in test")),
    streamDomainEvents: Stream.fromQueue(eventQueue),
  };
  const layer = SubAgentOrchestratorLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProviderDiscoveryService, createDiscoveryStub(true))),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, createProjectionStub(threads))),
  );
  const runtime = ManagedRuntime.make(layer);
  const setThread = (thread: OrchestrationThread): void => {
    threads.set(thread.id, thread);
  };
  const pushEvent = (event: OrchestrationEvent): void => {
    Effect.runSync(Queue.offer(eventQueue, event));
  };
  return { runtime, setThread, pushEvent };
}

function resultById<T extends { readonly agentId: string }>(
  results: readonly T[],
  id: ThreadId,
): T {
  const result = results.find((entry) => entry.agentId === id);
  if (!result) {
    throw new Error(`expected a result for agent ${id}`);
  }
  return result;
}

/**
 * A fake OrchestrationEngineService that records every dispatched command so a
 * test can assert on the exact command sequence spawn emits. Only `dispatch` is
 * meaningful; the read/stream members are inert (mirrors how reactor tests stub
 * out unused provider methods).
 */
function createRecordingEngine() {
  const commands: OrchestrationCommand[] = [];
  const engine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    getReadModel: () => Effect.die(new Error("getReadModel unused in test")),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    repairState: () => Effect.die(new Error("repairState unused in test")),
    streamDomainEvents: Stream.empty,
  };
  return { engine, commands };
}

/**
 * A stub ProviderDiscoveryService that reports the requested provider as either
 * available (getComposerCapabilities succeeds) or unavailable (fails with the
 * same ProviderUnsupportedError the real discovery layer raises for an
 * unregistered provider).
 */
function createDiscoveryStub(available: boolean): ProviderDiscoveryServiceShape {
  const unused = () => Effect.die(new Error("provider discovery method unused in test"));
  const getComposerCapabilities: ProviderDiscoveryServiceShape["getComposerCapabilities"] = (
    input,
  ) =>
    available
      ? Effect.succeed({
          provider: input.provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: false,
        } satisfies ProviderComposerCapabilities)
      : Effect.fail(new ProviderUnsupportedError({ provider: input.provider }));
  return {
    getComposerCapabilities,
    listCommands: unused,
    listSkills: unused,
    listPlugins: unused,
    readPlugin: unused,
    listModels: unused,
    listAgents: unused,
  };
}

function buildHarness(input: { readonly available: boolean }) {
  const { engine, commands } = createRecordingEngine();
  const layer = SubAgentOrchestratorLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProviderDiscoveryService, createDiscoveryStub(input.available))),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, createProjectionStub(new Map()))),
  );
  const runtime = ManagedRuntime.make(layer);
  return { runtime, commands };
}

const LOCAL_WORKSPACE: SubAgentSpawnCaller["workspace"] = {
  envMode: "local",
  worktreePath: null,
  branch: null,
};

function makeCaller(
  workspace: SubAgentSpawnCaller["workspace"] = LOCAL_WORKSPACE,
): SubAgentSpawnCaller {
  return {
    threadId: ThreadId.makeUnsafe(randomUUID()),
    projectId: ProjectId.makeUnsafe(randomUUID()),
    workspace,
    canSpawn: true,
  };
}

describe("SubAgentOrchestrator.spawn (share-cwd)", () => {
  it("dispatches thread.create then thread.turn.start for a shared-cwd child", async () => {
    const { runtime, commands } = buildHarness({ available: true });
    const caller = makeCaller();
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "share",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const result = await runtime.runPromise(orchestrator.spawn(caller, input));

      expect(commands).toHaveLength(2);

      const createCommand = commands[0];
      if (createCommand?.type !== "thread.create") {
        throw new Error("expected the first dispatched command to be thread.create");
      }
      expect(createCommand.parentThreadId).toBe(caller.threadId);
      expect(createCommand.projectId).toBe(caller.projectId);
      expect(createCommand.subagentRole).toBeNull();
      expect(createCommand.subagentNickname).toBeNull();
      expect(createCommand.subagentAgentId).toBe(result.agentId);
      expect(createCommand.envMode).toBe("local");
      expect(createCommand.branch).toBeNull();
      expect(createCommand.worktreePath).toBeNull();
      expect(createCommand.threadId).toBe(result.agentId);
      expect(createCommand.runtimeMode).toBe("full-access");
      expect(createCommand.modelSelection.provider).toBe("codex");
      expect(createCommand.modelSelection.model).toBeTruthy();
      expect(createCommand.title.length).toBeGreaterThan(0);

      const turnCommand = commands[1];
      if (turnCommand?.type !== "thread.turn.start") {
        throw new Error("expected the second dispatched command to be thread.turn.start");
      }
      expect(turnCommand.threadId).toBe(result.agentId);
      expect(turnCommand.message.text).toBe("validate");

      expect(result.agentId).toBe(createCommand.threadId);
    } finally {
      await runtime.dispose();
    }
  });

  it("fails with provider-unavailable when the provider is not available", async () => {
    const { runtime, commands } = buildHarness({ available: false });
    const caller = makeCaller();
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "share",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const error = await runtime.runPromise(orchestrator.spawn(caller, input).pipe(Effect.flip));

      expect(error).toBeInstanceOf(SubAgentError);
      expect(error.reason).toBe("provider-unavailable");
      expect(commands).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("fails with model-unavailable when no model is given and the provider has no default", async () => {
    const { runtime, commands } = buildHarness({ available: true });
    const caller = makeCaller();
    // "pi" has no default model (getDefaultModel("pi") === null); omitting
    // `model` must fail fast rather than dispatch a thread.create with a
    // null model.
    const input = decodeSpawnInput({
      provider: "pi",
      task: "x",
      workspace: "share",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const error = await runtime.runPromise(orchestrator.spawn(caller, input).pipe(Effect.flip));

      expect(error).toBeInstanceOf(SubAgentError);
      expect(error.reason).toBe("model-unavailable");
      expect(commands).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("copies the caller's worktree workspace fields onto a 'share' child (share parent cwd)", async () => {
    const { runtime, commands } = buildHarness({ available: true });
    const callerWorkspace: SubAgentSpawnCaller["workspace"] = {
      envMode: "worktree",
      worktreePath: "/wt/x",
      branch: "feat/x",
    };
    const caller = makeCaller(callerWorkspace);
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "share",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      await runtime.runPromise(orchestrator.spawn(caller, input));

      const createCommand = commands[0];
      if (createCommand?.type !== "thread.create") {
        throw new Error("expected the first dispatched command to be thread.create");
      }
      expect(createCommand.envMode).toBe("worktree");
      expect(createCommand.worktreePath).toBe("/wt/x");
      expect(createCommand.branch).toBe("feat/x");

      // The point of copying these fields verbatim is that
      // resolveThreadWorkspaceCwd resolves the child to the same cwd as the
      // caller, given the same project root.
      const projectCwd = "/project/root";
      const callerCwd = resolveThreadWorkspaceCwd({
        projectCwd,
        envMode: callerWorkspace.envMode,
        worktreePath: callerWorkspace.worktreePath,
      });
      const childCwd = resolveThreadWorkspaceCwd({
        projectCwd,
        envMode: createCommand.envMode,
        worktreePath: createCommand.worktreePath,
      });
      expect(childCwd).toBe(callerCwd);
      expect(childCwd).toBe("/wt/x");
    } finally {
      await runtime.dispose();
    }
  });

  it("maps approval 'ask-human' to runtimeMode 'approval-required'", async () => {
    const { runtime, commands } = buildHarness({ available: true });
    const caller = makeCaller();
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "share",
      approval: "ask-human",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      await runtime.runPromise(orchestrator.spawn(caller, input));

      const createCommand = commands[0];
      if (createCommand?.type !== "thread.create") {
        throw new Error("expected the first dispatched command to be thread.create");
      }
      expect(createCommand.runtimeMode).toBe("approval-required");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("SubAgentOrchestrator.wait (terminal collection)", () => {
  it("returns one completed envelope with the child's last assistant message once its turn finishes", async () => {
    const { runtime, setThread, pushEvent } = buildWaitHarness();
    const child = ThreadId.makeUnsafe(randomUUID());
    // Seed NON-terminal (session running) so resolution is driven purely by the
    // domain-event stream, not the seed snapshot.
    setThread(
      makeThread({
        id: child,
        messages: [
          { role: "user", text: "do the thing" },
          { role: "assistant", text: "all done, here is the result" },
        ],
        session: makeSession(child, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );
    // The engine emits the child's turn completion then a return to idle.
    pushEvent(turnDiffCompletedEvent(child));
    pushEvent(sessionSetEvent(child, makeSession(child, { status: "idle", activeTurnId: null })));

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const results = await runtime.runPromise(
        orchestrator.wait(decodeWaitInput({ agentIds: [child], mode: "all", timeoutSeconds: 30 })),
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result?.status).toBe("completed");
      expect(result?.finalMessage).toBe("all done, here is the result");
      expect(result?.agentId).toBe(child);
      expect(result?.threadId).toBe(child);
      expect(result?.provider).toBe("codex");
      expect(result?.model).toBe("gpt-5-codex");
      expect(result?.diff).toBeNull();
      expect(result?.error).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it("returns a failed envelope carrying the session error when the child errors", async () => {
    const { runtime, setThread, pushEvent } = buildWaitHarness();
    const child = ThreadId.makeUnsafe(randomUUID());
    // Seed running (non-terminal) with the lastError already on the thread so the
    // build-time read surfaces it; the error session-set event drives the failed
    // resolution through the stream.
    setThread(
      makeThread({
        id: child,
        messages: [{ role: "user", text: "go" }],
        session: makeSession(child, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
          lastError: "provider exploded",
        }),
        latestTurnState: "running",
      }),
    );
    pushEvent(
      sessionSetEvent(
        child,
        makeSession(child, { status: "error", lastError: "provider exploded" }),
      ),
    );

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const results = await runtime.runPromise(
        orchestrator.wait(decodeWaitInput({ agentIds: [child], mode: "all", timeoutSeconds: 30 })),
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("failed");
      expect(results[0]?.error).toBe("provider exploded");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns a running envelope on timeout instead of hanging", async () => {
    const { runtime, setThread } = buildWaitHarness();
    const child = ThreadId.makeUnsafe(randomUUID());
    // Never-finishing child: seeded running, no terminal event ever pushed.
    setThread(
      makeThread({
        id: child,
        messages: [{ role: "user", text: "go" }],
        session: makeSession(child, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      // timeoutSeconds clamps to 1s (PositiveInt floor) — the call returns rather
      // than hanging for the 600s default.
      const results = await runtime.runPromise(
        orchestrator.wait(decodeWaitInput({ agentIds: [child], mode: "all", timeoutSeconds: 1 })),
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("running");
      expect(results[0]?.error).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it("resolves a child that is already terminal at seed time without hanging", async () => {
    const { runtime, setThread } = buildWaitHarness();
    const child = ThreadId.makeUnsafe(randomUUID());
    // Already idle after a completed turn — must resolve immediately from the seed
    // snapshot, not wait for an event or the timeout.
    setThread(
      makeThread({
        id: child,
        messages: [
          { role: "user", text: "task" },
          { role: "assistant", text: "seed-final" },
        ],
        session: makeSession(child, { status: "idle", activeTurnId: null }),
        latestTurnState: "completed",
      }),
    );

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const results = await runtime.runPromise(
        orchestrator.wait(decodeWaitInput({ agentIds: [child], mode: "all", timeoutSeconds: 30 })),
      );

      expect(results[0]?.status).toBe("completed");
      expect(results[0]?.finalMessage).toBe("seed-final");
    } finally {
      await runtime.dispose();
    }
  });

  it("mode 'any' resolves as soon as the first child finishes", async () => {
    const { runtime, setThread, pushEvent } = buildWaitHarness();
    const finished = ThreadId.makeUnsafe(randomUUID());
    const stillRunning = ThreadId.makeUnsafe(randomUUID());
    setThread(
      makeThread({
        id: finished,
        messages: [
          { role: "user", text: "a" },
          { role: "assistant", text: "first done" },
        ],
        session: makeSession(finished, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );
    setThread(
      makeThread({
        id: stillRunning,
        messages: [{ role: "user", text: "b" }],
        session: makeSession(stillRunning, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );
    // Only the first child finishes.
    pushEvent(turnDiffCompletedEvent(finished));

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      // A large timeout proves "any" returns on the first terminal child rather
      // than waiting on the still-running one (or the timeout).
      const results = await runtime.runPromise(
        orchestrator.wait(
          decodeWaitInput({ agentIds: [finished, stillRunning], mode: "any", timeoutSeconds: 60 }),
        ),
      );

      expect(results).toHaveLength(2);
      expect(resultById(results, finished).status).toBe("completed");
      expect(resultById(results, finished).finalMessage).toBe("first done");
      expect(resultById(results, stillRunning).status).toBe("running");
    } finally {
      await runtime.dispose();
    }
  });

  it("preserves agentIds order and detects idle-after-run completion", async () => {
    const { runtime, setThread, pushEvent } = buildWaitHarness();
    const viaTurnDiff = ThreadId.makeUnsafe(randomUUID());
    const viaIdle = ThreadId.makeUnsafe(randomUUID());
    setThread(
      makeThread({
        id: viaTurnDiff,
        messages: [
          { role: "user", text: "a" },
          { role: "assistant", text: "A-final" },
        ],
        session: makeSession(viaTurnDiff, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );
    setThread(
      makeThread({
        id: viaIdle,
        messages: [
          { role: "user", text: "b" },
          { role: "assistant", text: "B-final" },
        ],
        session: makeSession(viaIdle, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );
    pushEvent(turnDiffCompletedEvent(viaTurnDiff));
    // Running -> idle with no active turn is a finished turn (idle-after-run).
    pushEvent(
      sessionSetEvent(viaIdle, makeSession(viaIdle, { status: "idle", activeTurnId: null })),
    );

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      // Pass the ids in reverse to prove order follows the input, not resolution.
      const results = await runtime.runPromise(
        orchestrator.wait(
          decodeWaitInput({ agentIds: [viaIdle, viaTurnDiff], mode: "all", timeoutSeconds: 30 }),
        ),
      );

      expect(results.map((entry) => entry.agentId)).toEqual([viaIdle, viaTurnDiff]);
      expect(results[0]?.status).toBe("completed");
      expect(results[0]?.finalMessage).toBe("B-final");
      expect(results[1]?.status).toBe("completed");
      expect(results[1]?.finalMessage).toBe("A-final");
    } finally {
      await runtime.dispose();
    }
  });

  it("fails the whole call with unknown-agent when an agentId has no backing thread", async () => {
    const { runtime } = buildWaitHarness();
    const missing = ThreadId.makeUnsafe(randomUUID());

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const error = await runtime.runPromise(
        orchestrator.wait(decodeWaitInput({ agentIds: [missing], mode: "all" })).pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(SubAgentError);
      expect(error.reason).toBe("unknown-agent");
    } finally {
      await runtime.dispose();
    }
  });
});
