/**
 * crossModel.integration.test.ts - End-to-end cross-model delegation (Task 8.1).
 *
 * The feature's acceptance test: drives the REAL `OrchestrationLayerLive`
 * (in-memory sqlite, the same composition `SubAgentApprovalResolver.test.ts`
 * and `SubAgentOrchestrator.test.ts`'s "layer wiring" describe block use) +
 * REAL `SubAgentOrchestratorLive` + REAL `SubAgentMcpServerLive` + REAL
 * `SessionTokenRegistryLive`, with only the PROVIDER runtime stubbed
 * (`ProviderDiscoveryService`, so no real Codex/Claude/Cursor process is
 * spawned) and `GitCore` stubbed for the worktree scenario (so no real `git
 * worktree add` runs). Every other layer in the spawn -> child runs ->
 * `wait` -> envelope path is the real implementation: the real engine, the
 * real decider/projector/projection-pipeline, the real
 * `SubAgentOrchestrator.spawn`/`wait`, and the real MCP JSON-RPC handler.
 *
 * Since no real provider process runs, a spawned child never actually
 * produces output on its own. Each scenario below drives the child to a
 * terminal state by dispatching the SAME commands ProviderRuntimeIngestion
 * dispatches for a real finished turn (see
 * `Layers/ProviderRuntimeIngestion.ts`): a `thread.message.assistant.delta`
 * carrying the final assistant text, optionally a `thread.turn.diff.complete`
 * checkpoint (mirroring `CheckpointReactor.test.ts`'s command shape), and a
 * `thread.session.set` returning the child to `idle` with `activeTurnId:
 * null`. This is exactly the completion signal `SubAgentOrchestrator.wait`
 * (`Layers/SubAgentOrchestrator.ts`) is built to detect -- see its own
 * `classifySession`/`hasRun` doc comments -- so driving it via real commands
 * through the real engine exercises the real decider/projector path instead
 * of a hand-rolled fake domain event.
 *
 * Design source of truth:
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md
 *
 * @module crossModel.integration.test
 */
import { randomUUID } from "node:crypto";

import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationCheckpointFile,
  type OrchestrationEvent,
  type ProviderComposerCapabilities,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { GitCore, type GitCoreShape } from "../git/Services/GitCore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../provider/Services/ProviderDiscoveryService.ts";
import { SubAgentOrchestratorLive } from "../orchestration/Layers/SubAgentOrchestrator.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { SessionTokenRegistry, SessionTokenRegistryLive } from "./SessionTokenRegistry.ts";
import {
  type JsonRpcSuccessResponse,
  SubAgentMcpServer,
  SubAgentMcpServerLive,
  type SubAgentMcpServerShape,
} from "./SubAgentMcpServer.ts";
import type { SessionTokenIdentity } from "./SessionTokenRegistry.ts";

/**
 * A `ProviderDiscoveryService` stub that reports every provider as available
 * (`getComposerCapabilities` always succeeds) -- standing up the real
 * `ProviderDiscoveryServiceLive` would require the full provider adapter
 * registry, which spawns real provider CLI processes (out of scope here, and
 * exactly what this test must NOT do). Mirrors the same stub every
 * `SubAgentOrchestrator.test.ts`/`SubAgentOrchestratorLive` wiring test uses.
 */
function createDiscoveryStub(): ProviderDiscoveryServiceShape {
  const unused = () => Effect.die(new Error("provider discovery method unused in test"));
  const getComposerCapabilities: ProviderDiscoveryServiceShape["getComposerCapabilities"] = (
    input,
  ) =>
    Effect.succeed({
      provider: input.provider,
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: false,
    } satisfies ProviderComposerCapabilities);
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
 * A fake `GitCore` for the `workspace:"worktree"` spawn path: `createWorktree`
 * records every input and returns a canned `{worktreePath, branch}` so
 * `spawn` never shells out to real `git`. Mirrors
 * `SubAgentOrchestrator.test.ts`'s `createGitCoreStub`, trimmed to only the
 * member `spawn`'s worktree path actually calls.
 */
function createGitCoreStub(): { readonly gitCore: GitCoreShape; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  const createWorktree: GitCoreShape["createWorktree"] = (input) =>
    Effect.sync(() => {
      calls.push(input);
    }).pipe(
      Effect.flatMap(() =>
        Effect.succeed({
          worktree: {
            path: "/tmp/cross-model-subagent-worktree",
            branch: input.newBranch ?? input.branch,
          },
        }),
      ),
    );
  return { gitCore: { createWorktree } as unknown as GitCoreShape, calls };
}

/**
 * The real stack: `OrchestrationLayerLive` (real engine + real
 * decider/projector/projection-pipeline, in-memory sqlite) -> real
 * `SubAgentOrchestratorLive` -> real `SubAgentMcpServerLive`, merged with the
 * real `SessionTokenRegistryLive`. Only `ProviderDiscoveryService` and
 * `GitCore` are test doubles (see module doc comment for why). This mirrors
 * `SubAgentOrchestrator.test.ts`'s "SubAgentOrchestratorLive layer wiring"
 * describe block, extended one layer further to also stand up the real MCP
 * handler and token registry.
 */
function buildIntegrationHarness(opts: { readonly gitCore?: GitCoreShape } = {}) {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-cross-model-integration-test-",
  });
  const orchestrationLayer = OrchestrationLayerLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const subAgentOrchestratorLayer = SubAgentOrchestratorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provide(Layer.succeed(ProviderDiscoveryService, createDiscoveryStub())),
    Layer.provide(Layer.succeed(GitCore, opts.gitCore ?? createGitCoreStub().gitCore)),
  );
  const mcpLayer = SubAgentMcpServerLive.pipe(Layer.provideMerge(subAgentOrchestratorLayer));
  const fullLayer = Layer.mergeAll(mcpLayer, SessionTokenRegistryLive);
  const runtime = ManagedRuntime.make(fullLayer);
  return { runtime };
}

/**
 * Dispatches `project.create` then `thread.create` for a root (human-facing,
 * Claude-stub) session -- NOT a sub-agent itself, so `parentThreadId`/
 * `subagentApproval` stay at their schema defaults (null). Mirrors
 * `SubAgentApprovalResolver.test.ts`'s `seedThread` helper.
 */
async function seedRootThread(
  engine: OrchestrationEngineShape,
  opts: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  },
): Promise<void> {
  const createdAt = new Date().toISOString();
  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(`cmd-project-create-${randomUUID()}`),
      projectId: opts.projectId,
      title: "Root project",
      workspaceRoot: opts.workspaceRoot,
      createdAt,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(`cmd-thread-create-${randomUUID()}`),
      threadId: opts.threadId,
      projectId: opts.projectId,
      title: "Root thread (Claude)",
      modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      envMode: "local",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );
}

/**
 * Drives a spawned child to a terminal "completed" state by dispatching the
 * same commands ProviderRuntimeIngestion dispatches for a real finished turn
 * (see module doc comment): a final assistant message, an optional
 * file-bearing checkpoint (Task 4.3's `workspace:"worktree"` diff path,
 * mirroring `CheckpointReactor.test.ts`'s `thread.turn.diff.complete`
 * command shape), then a `thread.session.set` returning the child to `idle`
 * with `activeTurnId: null` -- the exact signal
 * `SubAgentOrchestrator.wait`'s `classifySession` resolves as `"completed"`.
 */
async function completeChildTurn(
  engine: OrchestrationEngineShape,
  childId: ThreadId,
  opts: {
    readonly finalMessage: string;
    readonly checkpointFiles?: ReadonlyArray<OrchestrationCheckpointFile>;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.makeUnsafe(`cmd-assistant-delta-${randomUUID()}`),
      threadId: childId,
      messageId: MessageId.makeUnsafe(randomUUID()),
      delta: opts.finalMessage,
      createdAt: now,
    }),
  );
  if (opts.checkpointFiles) {
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe(`cmd-turn-diff-${randomUUID()}`),
        threadId: childId,
        turnId: TurnId.makeUnsafe(randomUUID()),
        completedAt: now,
        checkpointRef: CheckpointRef.makeUnsafe(randomUUID()),
        status: "ready",
        files: opts.checkpointFiles,
        checkpointTurnCount: 1,
        createdAt: now,
      }),
    );
  }
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`cmd-session-idle-${randomUUID()}`),
      threadId: childId,
      session: {
        threadId: childId,
        status: "idle",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    }),
  );
}

/** Every persisted domain event so far, in order. */
async function collectEvents(engine: OrchestrationEngineShape): Promise<OrchestrationEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(engine.readEvents(0)));
  return Array.from(chunk);
}

interface ToolCallResultShape {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly isError?: boolean;
}

/** Calls `tools/call <name>` through the REAL MCP handler and unwraps the tool result. */
async function callTool(
  mcpServer: SubAgentMcpServerShape,
  caller: SessionTokenIdentity,
  id: number,
  name: string,
  args: unknown,
): Promise<ToolCallResultShape> {
  const response = await Effect.runPromise(
    mcpServer.handle(caller, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
  return result.result as ToolCallResultShape;
}

describe("cross-model sub-agent delegation (Task 8.1: end-to-end, real stack)", () => {
  it("share-cwd delegation: spawn_agent creates a real child thread + turn, and wait returns a completed envelope with the child's final message", async () => {
    const { runtime } = buildIntegrationHarness();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const projection = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const tokens = await runtime.runPromise(Effect.service(SessionTokenRegistry));
      const mcpServer = await runtime.runPromise(Effect.service(SubAgentMcpServer));

      // 1. Seed a root project + root (Claude-stub) thread, then issue it a
      // canSpawn:true token -- simulating the root's own live session.
      const rootProjectId = ProjectId.makeUnsafe(randomUUID());
      const rootThreadId = ThreadId.makeUnsafe(randomUUID());
      await seedRootThread(engine, {
        projectId: rootProjectId,
        threadId: rootThreadId,
        workspaceRoot: "/tmp/cross-model-share-project",
      });
      const token = await runtime.runPromise(tokens.issueToken(rootThreadId, { canSpawn: true }));
      const identityOption = await runtime.runPromise(tokens.resolve(token));
      const identity = Option.getOrThrow(identityOption);
      expect(identity.threadId).toBe(rootThreadId);
      expect(identity.canSpawn).toBe(true);

      // 2. spawn_agent through the REAL MCP handler.
      const spawnResult = await callTool(mcpServer, identity, 1, "spawn_agent", {
        provider: "codex",
        task: "validate X",
        workspace: "share",
      });
      expect(spawnResult.isError).toBeUndefined();
      const { agentId } = JSON.parse(spawnResult.content[0]!.text) as { agentId: string };
      expect(agentId).toBeTruthy();
      const childId = ThreadId.makeUnsafe(agentId);

      // A real CHILD thread now exists in the projection, linked to the root.
      const childOption = await runtime.runPromise(projection.getThreadDetailById(childId));
      const child = Option.getOrThrow(childOption);
      expect(child.parentThreadId).toBe(rootThreadId);
      expect(child.modelSelection.provider).toBe("codex");
      // "share" copies the root's own workspace verbatim (share-cwd, decision 5).
      expect(child.envMode).toBe("local");

      // A real thread.turn.start was dispatched for the child (not just
      // thread.create): the decider's "thread.turn.start" case always emits a
      // "thread.turn-start-requested" event alongside the user message.
      const events = await collectEvents(engine);
      const turnStartEvent = events.find(
        (event) =>
          event.type === "thread.turn-start-requested" && event.payload.threadId === childId,
      );
      expect(turnStartEvent).toBeDefined();
      const userMessageEvent = events.find(
        (event) =>
          event.type === "thread.message-sent" &&
          event.payload.threadId === childId &&
          event.payload.role === "user",
      );
      expect(userMessageEvent).toBeDefined();
      if (userMessageEvent?.type === "thread.message-sent") {
        expect(userMessageEvent.payload.text).toBe("validate X");
      }

      // 3. SIMULATE the child completing (no real provider runs): dispatch its
      // final assistant message + a return to idle, exactly as
      // ProviderRuntimeIngestion would for a real finished turn.
      await completeChildTurn(engine, childId, {
        finalMessage: "All done, X is valid.",
      });

      // 4. wait through the REAL MCP handler.
      const waitResult = await callTool(mcpServer, identity, 2, "wait", {
        agentIds: [agentId],
        timeoutSeconds: 5,
      });
      expect(waitResult.isError).toBeUndefined();
      const envelopes = JSON.parse(waitResult.content[0]!.text) as ReadonlyArray<{
        readonly agentId: string;
        readonly status: string;
        readonly finalMessage: string;
        readonly provider: string;
        readonly diff: unknown;
        readonly error: unknown;
      }>;
      expect(envelopes).toHaveLength(1);
      const envelope = envelopes[0]!;
      expect(envelope.agentId).toBe(agentId);
      expect(envelope.status).toBe("completed");
      expect(envelope.finalMessage).toBe("All done, X is valid.");
      expect(envelope.provider).toBe("codex");
      expect(envelope.diff).toBeNull();
      expect(envelope.error).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it("worktree delegation: spawn_agent provisions a real isolated worktree, and wait returns a completed envelope with a non-null diff", async () => {
    const { gitCore, calls } = createGitCoreStub();
    const { runtime } = buildIntegrationHarness({ gitCore });
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const projection = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const tokens = await runtime.runPromise(Effect.service(SessionTokenRegistry));
      const mcpServer = await runtime.runPromise(Effect.service(SubAgentMcpServer));

      const rootProjectId = ProjectId.makeUnsafe(randomUUID());
      const rootThreadId = ThreadId.makeUnsafe(randomUUID());
      const workspaceRoot = "/tmp/cross-model-worktree-project";
      await seedRootThread(engine, {
        projectId: rootProjectId,
        threadId: rootThreadId,
        workspaceRoot,
      });
      const token = await runtime.runPromise(tokens.issueToken(rootThreadId, { canSpawn: true }));
      const identity = Option.getOrThrow(await runtime.runPromise(tokens.resolve(token)));

      // 5. spawn_agent with workspace:"worktree" through the REAL MCP handler.
      // GitCore.createWorktree is stubbed (Task 4.1's worktree provisioning
      // otherwise shells out to real git) but everything else -- provider
      // discovery, thread.create, thread.turn.start -- is real.
      const spawnResult = await callTool(mcpServer, identity, 1, "spawn_agent", {
        provider: "codex",
        task: "implement Y",
        workspace: "worktree",
      });
      expect(spawnResult.isError).toBeUndefined();
      const { agentId } = JSON.parse(spawnResult.content[0]!.text) as { agentId: string };
      const childId = ThreadId.makeUnsafe(agentId);

      // The stubbed GitCore was actually invoked (real worktree-provisioning
      // code path ran), branching from the parent project's repo root.
      expect(calls).toHaveLength(1);
      const call = calls[0] as { readonly cwd: string; readonly branch: string };
      expect(call.cwd).toBe(workspaceRoot);
      expect(call.branch).toBe("HEAD");

      const childOption = await runtime.runPromise(projection.getThreadDetailById(childId));
      const child = Option.getOrThrow(childOption);
      expect(child.parentThreadId).toBe(rootThreadId);
      expect(child.envMode).toBe("worktree");
      expect(child.branch).toBeTruthy();
      expect(child.worktreePath).toBe("/tmp/cross-model-subagent-worktree");
      const childBranch = child.branch!;

      // 6. SIMULATE the writer child completing WITH a file-bearing checkpoint
      // (Task 4.3's diff envelope) -- mirrors CheckpointReactor.test.ts's
      // thread.turn.diff.complete command shape.
      await completeChildTurn(engine, childId, {
        finalMessage: "Implemented Y.",
        checkpointFiles: [
          { path: "src/a.ts", kind: "modified", additions: 5, deletions: 2 },
          { path: "src/b.ts", kind: "added", additions: 1, deletions: 0 },
        ],
      });

      // 7. wait through the REAL MCP handler.
      const waitResult = await callTool(mcpServer, identity, 2, "wait", {
        agentIds: [agentId],
        timeoutSeconds: 5,
      });
      expect(waitResult.isError).toBeUndefined();
      const envelopes = JSON.parse(waitResult.content[0]!.text) as ReadonlyArray<{
        readonly agentId: string;
        readonly status: string;
        readonly diff: {
          readonly branch: string;
          readonly filesChanged: number;
          readonly summary: string;
        } | null;
      }>;
      expect(envelopes).toHaveLength(1);
      const envelope = envelopes[0]!;
      expect(envelope.status).toBe("completed");
      expect(envelope.diff).toEqual({
        branch: childBranch,
        filesChanged: 2,
        summary: "2 files changed, +6/-2",
      });
    } finally {
      await runtime.dispose();
    }
  });
});
