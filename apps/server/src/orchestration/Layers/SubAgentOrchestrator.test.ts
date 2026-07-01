import { randomUUID } from "node:crypto";

import {
  type GitCreateWorktreeInput,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  OrchestrationThread,
  type OrchestrationProjectShell,
  ProjectId,
  type ProviderComposerCapabilities,
  SubAgentSpawnInput,
  SubAgentWaitInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option, PubSub, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
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
import { OrchestrationLayerLive } from "../runtimeLayer.ts";
import { SubAgentOrchestratorLive } from "./SubAgentOrchestrator.ts";

const decodeSpawnInput = Schema.decodeUnknownSync(SubAgentSpawnInput);
const decodeWaitInput = Schema.decodeUnknownSync(SubAgentWaitInput);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);

/**
 * A ProjectionSnapshotQuery test double backed by a mutable thread map.
 * `getThreadDetailById` and `getProjectShellById` are the only meaningful
 * members -- `wait` reads each child's envelope/state through the former,
 * and the `spawn` worktree path (Task 4.1) resolves the parent project's repo
 * root through the latter before provisioning a worktree; the rest are inert
 * (mirrors how the discovery/engine doubles stub out unused members).
 * `getProjectShellById` resolves to `Option.none()` when no `project` is
 * given (or the id doesn't match) rather than dying, so a test can exercise
 * the "parent project not found" failure path.
 */
function createProjectionStub(
  threads: ReadonlyMap<string, OrchestrationThread>,
  project?: OrchestrationProjectShell,
): ProjectionSnapshotQueryShape {
  const unused = () => Effect.die(new Error("projection snapshot method unused in test"));
  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    Effect.sync(() => {
      const thread = threads.get(threadId);
      return thread ? Option.some(thread) : Option.none();
    });
  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    Effect.sync(() => (project && project.id === projectId ? Option.some(project) : Option.none()));
  return {
    getCommandReadModel: unused,
    getSnapshot: unused,
    getCounts: unused,
    getSnapshotSequence: unused,
    getShellSnapshot: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShellById,
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
 * Harness for `wait`: a recording engine whose event delivery is backed by a
 * real `PubSub` with a generous replay buffer, so `wait`'s subscription
 * (however late it starts relative to a test's `pushEvent` calls) still
 * receives every event a test pushed beforehand -- every test in this file
 * publishes events BEFORE calling `wait`, and the replay buffer keeps that
 * publish-then-wait ordering deterministic regardless of subscribe timing.
 * `streamDomainEvents` and `subscribeDomainEvents` share the same underlying
 * PubSub, mirroring the real engine (`Layers/OrchestrationEngine.ts`).
 *
 * Contrast with `buildMidSeedWaitHarness` below, which deliberately uses a
 * PubSub with NO replay buffer to exercise real subscribe-timing semantics --
 * that is the one that can distinguish the eager-subscribe fix from the
 * `Stream.toPull` bug it replaces.
 */
function buildWaitHarness() {
  const eventPubSub = Effect.runSync(PubSub.unbounded<OrchestrationEvent>({ replay: 16 }));
  const threads = new Map<string, OrchestrationThread>();
  const engine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    getReadModel: () => Effect.die(new Error("getReadModel unused in test")),
    dispatch: () => Effect.die(new Error("dispatch unused in wait test")),
    repairState: () => Effect.die(new Error("repairState unused in test")),
    streamDomainEvents: Stream.fromPubSub(eventPubSub),
    subscribeDomainEvents: PubSub.subscribe(eventPubSub),
  };
  const layer = SubAgentOrchestratorLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProviderDiscoveryService, createDiscoveryStub(true))),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, createProjectionStub(threads))),
    // `wait` never touches GitCore -- SubAgentOrchestratorLive now requires it
    // unconditionally at layer-build time (Task 4.1's worktree provisioning),
    // so every harness must supply one even where it's never called.
    Layer.provide(Layer.succeed(GitCore, createGitCoreStub().gitCore)),
  );
  const runtime = ManagedRuntime.make(layer);
  const setThread = (thread: OrchestrationThread): void => {
    threads.set(thread.id, thread);
  };
  const pushEvent = (event: OrchestrationEvent): void => {
    Effect.runSync(PubSub.publish(eventPubSub, event));
  };
  return { runtime, setThread, pushEvent };
}

/**
 * A ProjectionSnapshotQuery double that, on the FIRST read of a designated
 * thread id, runs `onFirstRead` before returning the (still-seeded,
 * non-terminal) thread snapshot -- simulating a domain event landing on the
 * wire WHILE `wait`'s seed loop is mid-flight doing its SQL-equivalent read
 * for that exact child. Subsequent reads (e.g. `wait`'s final result-building
 * pass) return the thread unmodified, with no further side effect.
 */
function createMidSeedProjectionStub(
  threads: ReadonlyMap<string, OrchestrationThread>,
  midSeedThreadId: ThreadId,
  onFirstRead: () => void,
): ProjectionSnapshotQueryShape {
  const unused = () => Effect.die(new Error("projection snapshot method unused in test"));
  let firstReadDone = false;
  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    Effect.sync(() => {
      if (threadId === midSeedThreadId && !firstReadDone) {
        firstReadDone = true;
        onFirstRead();
      }
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

/**
 * Harness for the subscribe-before-seed regression test: a REAL, non-replay
 * `PubSub` (unlike `buildWaitHarness`'s replay-buffered one) backs both
 * `streamDomainEvents` and `subscribeDomainEvents`, so a subscriber only
 * receives events published AFTER `PubSub.subscribe` actually ran for it --
 * see the empirically-verified semantics in the `wait` step-1 comment in
 * `Layers/SubAgentOrchestrator.ts`. `ProjectionSnapshotQuery.getThreadDetailById`
 * publishes the target child's terminal event on its first invocation (the
 * seed loop's read for that child), landing it squarely in the "seed gap"
 * between subscribing and finishing the seed loop.
 */
function buildMidSeedWaitHarness(midSeedThreadId: ThreadId, midSeedEvent: OrchestrationEvent) {
  const eventPubSub = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  const threads = new Map<string, OrchestrationThread>();
  const publishEvent = (event: OrchestrationEvent): void => {
    Effect.runSync(PubSub.publish(eventPubSub, event));
  };
  const engine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    getReadModel: () => Effect.die(new Error("getReadModel unused in test")),
    dispatch: () => Effect.die(new Error("dispatch unused in wait test")),
    repairState: () => Effect.die(new Error("repairState unused in test")),
    streamDomainEvents: Stream.fromPubSub(eventPubSub),
    subscribeDomainEvents: PubSub.subscribe(eventPubSub),
  };
  const projection = createMidSeedProjectionStub(threads, midSeedThreadId, () =>
    publishEvent(midSeedEvent),
  );
  const layer = SubAgentOrchestratorLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProviderDiscoveryService, createDiscoveryStub(true))),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projection)),
    Layer.provide(Layer.succeed(GitCore, createGitCoreStub().gitCore)),
  );
  const runtime = ManagedRuntime.make(layer);
  const setThread = (thread: OrchestrationThread): void => {
    threads.set(thread.id, thread);
  };
  return { runtime, setThread };
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
    subscribeDomainEvents: Effect.die(new Error("subscribeDomainEvents unused in test")),
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

/**
 * A fake GitCore for the `workspace:"worktree"` spawn path (Task 4.1). Only
 * `createWorktree` is meaningful -- it records every input and, absent a
 * configured `failure`, returns a canned successful result; the rest are
 * inert. Mirrors the partial-cast fake `gitCore` in
 * `automation/Layers/AutomationService.test.ts` (the primary template for
 * this task's worktree provisioning).
 */
function createGitCoreStub(options: { readonly failure?: GitCommandError } = {}): {
  readonly gitCore: GitCoreShape;
  readonly calls: GitCreateWorktreeInput[];
} {
  const calls: GitCreateWorktreeInput[] = [];
  const createWorktree = (input: GitCreateWorktreeInput) =>
    Effect.sync(() => {
      calls.push(input);
    }).pipe(
      Effect.flatMap(() =>
        options.failure
          ? Effect.fail(options.failure)
          : Effect.succeed({
              worktree: {
                path: "/tmp/subagent-worktree",
                branch: input.newBranch ?? input.branch,
              },
            }),
      ),
    );
  const gitCore = { createWorktree } as unknown as GitCoreShape;
  return { gitCore, calls };
}

function buildHarness(input: {
  readonly available: boolean;
  readonly gitCore?: GitCoreShape;
  readonly project?: OrchestrationProjectShell;
}) {
  const { engine, commands } = createRecordingEngine();
  const layer = SubAgentOrchestratorLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProviderDiscoveryService, createDiscoveryStub(input.available))),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, createProjectionStub(new Map(), input.project)),
    ),
    Layer.provide(Layer.succeed(GitCore, input.gitCore ?? createGitCoreStub().gitCore)),
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

/**
 * A minimal `OrchestrationProjectShell` for the `workspace:"worktree"` spawn
 * path: `spawn` reads only `workspaceRoot` off of it (via
 * `ProjectionSnapshotQuery.getProjectShellById`) to know where to run `git
 * worktree add`.
 */
function makeProjectShell(projectId: ProjectId, workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: projectId,
    kind: "project",
    title: "sub-agent parent project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: iso(0),
    updatedAt: iso(0),
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

describe("SubAgentOrchestrator.spawn (workspace:'worktree', Task 4.1)", () => {
  it("provisions an isolated worktree branching from the parent repo's HEAD and dispatches thread.create with the returned path/branch", async () => {
    const { gitCore, calls } = createGitCoreStub();
    const caller = makeCaller();
    const project = makeProjectShell(caller.projectId, "/repo/root");
    const { runtime, commands } = buildHarness({ available: true, gitCore, project });
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "worktree",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const result = await runtime.runPromise(orchestrator.spawn(caller, input));

      // The worktree is created in the parent PROJECT's repo root (not some
      // other path), branching from its current HEAD -- decision 10.
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.cwd).toBe(project.workspaceRoot);
      expect(call?.branch).toBe("HEAD");
      expect(call?.newBranch).toBeTruthy();
      expect(call?.path).toBeNull();

      const createCommand = commands[0];
      if (createCommand?.type !== "thread.create") {
        throw new Error("expected the first dispatched command to be thread.create");
      }
      expect(createCommand.envMode).toBe("worktree");
      expect(createCommand.worktreePath).toBe("/tmp/subagent-worktree");
      expect(createCommand.branch).toBe(call?.newBranch);
      expect(result.agentId).toBe(createCommand.threadId);

      const turnCommand = commands[1];
      if (turnCommand?.type !== "thread.turn.start") {
        throw new Error("expected the second dispatched command to be thread.turn.start");
      }
      expect(turnCommand.threadId).toBe(result.agentId);
    } finally {
      await runtime.dispose();
    }
  });

  it("does not provision a worktree for workspace:'share' (unchanged share path)", async () => {
    const { gitCore, calls } = createGitCoreStub();
    const { runtime, commands } = buildHarness({ available: true, gitCore });
    const caller = makeCaller();
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "share",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      await runtime.runPromise(orchestrator.spawn(caller, input));

      expect(calls).toHaveLength(0);
      expect(commands).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("fails with worktree-failed and dispatches no thread.create when createWorktree fails", async () => {
    const failure = new GitCommandError({
      operation: "GitCore.createWorktree",
      command: "git worktree add",
      cwd: "/repo/root",
      detail: "boom",
    });
    const { gitCore, calls } = createGitCoreStub({ failure });
    const caller = makeCaller();
    const project = makeProjectShell(caller.projectId, "/repo/root");
    const { runtime, commands } = buildHarness({ available: true, gitCore, project });
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "worktree",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const error = await runtime.runPromise(orchestrator.spawn(caller, input).pipe(Effect.flip));

      expect(error).toBeInstanceOf(SubAgentError);
      expect(error.reason).toBe("worktree-failed");
      expect(calls).toHaveLength(1);
      expect(commands).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("fails with worktree-failed when the caller's parent project cannot be found", async () => {
    const { gitCore, calls } = createGitCoreStub();
    // No `project` given to buildHarness -- getProjectShellById returns None.
    const { runtime, commands } = buildHarness({ available: true, gitCore });
    const caller = makeCaller();
    const input = decodeSpawnInput({
      provider: "codex",
      task: "validate",
      workspace: "worktree",
    });

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const error = await runtime.runPromise(orchestrator.spawn(caller, input).pipe(Effect.flip));

      expect(error).toBeInstanceOf(SubAgentError);
      expect(error.reason).toBe("worktree-failed");
      expect(calls).toHaveLength(0);
      expect(commands).toHaveLength(0);
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
    // The engine emits a live turn-diff placeholder (a no-op for `wait` — it
    // fires repeatedly DURING a turn and must NOT resolve the child) followed
    // by the real completion signal: a return to idle with no active turn.
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

  it("does not mark a freshly-spawned, not-yet-run child as completed at bare seed idle", async () => {
    const { runtime, setThread } = buildWaitHarness();
    const child = ThreadId.makeUnsafe(randomUUID());
    // A fresh spawn before the engine has picked up its queued turn: no
    // latestTurn, no assistant output, session sitting at a bare idle/starting
    // with activeTurnId null — i.e. NO run evidence at all. This must NOT be
    // mistaken for a finished turn (it would be if any seed idle counted as
    // completed); it stays "running" until it actually runs or times out.
    setThread(
      makeThread({
        id: child,
        messages: [{ role: "user", text: "delegated task" }],
        session: makeSession(child, { status: "idle", activeTurnId: null }),
        latestTurnState: null,
      }),
    );

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      // timeoutSeconds clamps to 1s (PositiveInt floor) — proves it returns
      // "running" rather than hanging or wrongly resolving "completed".
      const results = await runtime.runPromise(
        orchestrator.wait(decodeWaitInput({ agentIds: [child], mode: "all", timeoutSeconds: 1 })),
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("running");
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
    // Only the first child finishes: a real run -> finish transition (it was
    // seeded "running"; the session now returns to idle with no active turn).
    pushEvent(
      sessionSetEvent(finished, makeSession(finished, { status: "idle", activeTurnId: null })),
    );

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
    // Both children resolve via the SAME real run -> finish transition
    // (seeded "running", then a session-set event returns them to idle with no
    // active turn) — only the RESOLUTION order differs from the RESULT order,
    // to prove results follow `input.agentIds`, not which child resolves first.
    const childA = ThreadId.makeUnsafe(randomUUID());
    const childB = ThreadId.makeUnsafe(randomUUID());
    setThread(
      makeThread({
        id: childA,
        messages: [
          { role: "user", text: "a" },
          { role: "assistant", text: "A-final" },
        ],
        session: makeSession(childA, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );
    setThread(
      makeThread({
        id: childB,
        messages: [
          { role: "user", text: "b" },
          { role: "assistant", text: "B-final" },
        ],
        session: makeSession(childB, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );
    // childA's idle event is pushed (and resolves) first; childB's is queued
    // behind it and resolves second. Running -> idle with no active turn is a
    // finished turn (idle-after-run).
    pushEvent(sessionSetEvent(childA, makeSession(childA, { status: "idle", activeTurnId: null })));
    pushEvent(sessionSetEvent(childB, makeSession(childB, { status: "idle", activeTurnId: null })));

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      // Pass the ids in reverse of resolution order to prove the RESULT order
      // follows the input, not resolution order.
      const results = await runtime.runPromise(
        orchestrator.wait(
          decodeWaitInput({ agentIds: [childB, childA], mode: "all", timeoutSeconds: 30 }),
        ),
      );

      expect(results.map((entry) => entry.agentId)).toEqual([childB, childA]);
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

  it("catches a terminal event published DURING the seed loop's read for that child (subscribe-before-seed)", async () => {
    const child = ThreadId.makeUnsafe(randomUUID());
    // The child's real running -> idle completion signal. `buildMidSeedWaitHarness`
    // publishes this the INSTANT the seed loop calls getThreadDetailById(child) --
    // i.e. squarely in the gap between "start listening" and "finish seeding" that
    // `wait` step 1 exists to close. The harness's PubSub has no replay buffer, so
    // this event only reaches a subscriber that was ALREADY listening when it was
    // published.
    const midSeedEvent = sessionSetEvent(
      child,
      makeSession(child, { status: "idle", activeTurnId: null }),
    );
    const { runtime, setThread } = buildMidSeedWaitHarness(child, midSeedEvent);
    // The seed snapshot itself is still non-terminal ("running", active turn) --
    // resolution must come from the mid-seed published event being caught by the
    // eager subscription, not from the seed read itself.
    setThread(
      makeThread({
        id: child,
        messages: [
          { role: "user", text: "go" },
          { role: "assistant", text: "finished during seed" },
        ],
        session: makeSession(child, {
          status: "running",
          activeTurnId: TurnId.makeUnsafe(randomUUID()),
        }),
        latestTurnState: "running",
      }),
    );

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      const startedAt = Date.now();
      // timeoutSeconds clamps to a 1s floor. With subscribe-before-seed (the
      // fix), the mid-seed event is buffered by the already-live subscription
      // and applied by the drain fiber right after the seed loop, resolving
      // "completed" almost immediately -- well under 1s. With the prior
      // `Stream.toPull(engine.streamDomainEvents)` mechanism, the subscription
      // isn't actually registered until the drain fiber's first pull (AFTER
      // the seed loop), so this PubSub (no replay buffer) would have already
      // dropped the event; `wait` would then block for the full 1s and fall
      // through to "running". This is the assertion that distinguishes fixed
      // from broken.
      const results = await runtime.runPromise(
        orchestrator.wait(decodeWaitInput({ agentIds: [child], mode: "all", timeoutSeconds: 1 })),
      );
      const elapsedMs = Date.now() - startedAt;

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("completed");
      expect(results[0]?.finalMessage).toBe("finished during seed");
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("SubAgentOrchestratorLive layer wiring (Task 1.3: server composition regression)", () => {
  /**
   * `serverLayers.ts` provides `SubAgentOrchestratorLive`'s
   * `OrchestrationEngineService`/`ProjectionSnapshotQuery` dependencies via
   * the exact same `OrchestrationLayerLive` constant exercised here -- a real
   * engine + projection query backed by an in-memory sqlite, mirroring the
   * layer-wiring pattern already used by `OrchestrationEngine.test.ts` and
   * `ProviderCommandReactor.test.ts`. Only `ProviderDiscoveryService` is
   * stubbed: standing up the real `ProviderDiscoveryServiceLive` requires the
   * full provider adapter registry (which spawns real provider CLI
   * processes), which is out of scope for a focused wiring smoke test --
   * this is the SAME discovery stub every other test in this file already
   * uses. If `SubAgentOrchestratorLive`'s dependency set ever drifts from
   * what `OrchestrationLayerLive` exports (the missing-dependency regression
   * this task guards against), this test fails to construct the layer at
   * runtime instead of silently compiling. `GitCore` (Task 4.1's worktree
   * provisioning) is stubbed the same way `ProviderDiscoveryService` is --
   * `serverLayers.ts` provides the real `GitCoreLive` alongside
   * `OrchestrationLayerLive` (see `subAgentOrchestratorLayer`), but standing
   * up the real Git-backed layer is unnecessary for this wiring-only smoke
   * test.
   */
  it("resolves SubAgentOrchestrator from the real OrchestrationLayerLive plus a discovery stub", async () => {
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-subagent-orchestrator-wiring-test-",
    });
    const orchestrationLayer = OrchestrationLayerLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const layer = SubAgentOrchestratorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provide(Layer.succeed(ProviderDiscoveryService, createDiscoveryStub(true))),
      Layer.provide(Layer.succeed(GitCore, createGitCoreStub().gitCore)),
    );
    const runtime = ManagedRuntime.make(layer);

    try {
      const orchestrator = await runtime.runPromise(Effect.service(SubAgentOrchestrator));
      expect(typeof orchestrator.spawn).toBe("function");
      expect(typeof orchestrator.wait).toBe("function");
    } finally {
      await runtime.dispose();
    }
  });
});
