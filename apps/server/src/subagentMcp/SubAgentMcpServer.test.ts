import { randomUUID } from "node:crypto";

import {
  OrchestrationThread,
  ProjectId,
  type SubAgentResult,
  type SubAgentSpawnInput,
  type SubAgentWaitInput,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  SubAgentError,
  SubAgentOrchestrator,
  type SubAgentOrchestratorShape,
  type SubAgentSpawnCaller,
} from "../orchestration/Services/SubAgentOrchestrator.ts";
import type { SessionTokenIdentity } from "./SessionTokenRegistry.ts";
import {
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
  SubAgentMcpServer,
  SubAgentMcpServerLive,
} from "./SubAgentMcpServer.ts";

const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);

const NOW = new Date("2026-06-30T00:00:00.000Z").toISOString();
const CALLER_THREAD_ID = ThreadId.makeUnsafe("caller-thread");

function makeCallerThread(
  overrides: Partial<{
    readonly projectId: ProjectId;
    readonly envMode: "local" | "worktree";
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }> = {},
): OrchestrationThread {
  return decodeThread({
    id: CALLER_THREAD_ID,
    projectId: overrides.projectId ?? ProjectId.makeUnsafe(randomUUID()),
    title: "caller thread",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    envMode: overrides.envMode ?? "worktree",
    branch: "branch" in overrides ? overrides.branch : "feature/subagent-mcp",
    worktreePath: "worktreePath" in overrides ? overrides.worktreePath : "/tmp/worktrees/caller",
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  });
}

/**
 * A ProjectionSnapshotQuery test double backed by a mutable thread map. Only
 * `getThreadDetailById` is meaningful for these tests (`handleSpawnAgent`
 * resolves the caller's `projectId`/workspace through it) -- the rest are
 * inert, mirroring the stub pattern in `Layers/SubAgentOrchestrator.test.ts`.
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

interface OrchestratorFake {
  readonly shape: SubAgentOrchestratorShape;
  readonly spawnCalls: Array<{
    readonly caller: SubAgentSpawnCaller;
    readonly input: SubAgentSpawnInput;
  }>;
  readonly waitCalls: SubAgentWaitInput[];
}

/** A fake SubAgentOrchestrator that records every call and returns canned results. */
function createOrchestratorFake(
  opts: {
    readonly spawnResult?: Effect.Effect<{ agentId: ThreadId }, SubAgentError>;
    readonly waitResult?: Effect.Effect<readonly SubAgentResult[], SubAgentError>;
  } = {},
): OrchestratorFake {
  const spawnCalls: OrchestratorFake["spawnCalls"] = [];
  const waitCalls: SubAgentWaitInput[] = [];
  const spawn: SubAgentOrchestratorShape["spawn"] = (caller, input) => {
    spawnCalls.push({ caller, input });
    return opts.spawnResult ?? Effect.succeed({ agentId: ThreadId.makeUnsafe("child-thread-1") });
  };
  const wait: SubAgentOrchestratorShape["wait"] = (input) => {
    waitCalls.push(input);
    return opts.waitResult ?? Effect.succeed([]);
  };
  return { shape: { spawn, wait }, spawnCalls, waitCalls };
}

function runHandle(
  deps: {
    readonly orchestrator: SubAgentOrchestratorShape;
    readonly projection: ProjectionSnapshotQueryShape;
  },
  caller: SessionTokenIdentity,
  message: unknown,
) {
  const layer = SubAgentMcpServerLive.pipe(
    Layer.provide(Layer.succeed(SubAgentOrchestrator, deps.orchestrator)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, deps.projection)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* SubAgentMcpServer;
      return yield* server.handle(caller, message);
    }).pipe(Effect.provide(layer)),
  );
}

interface ToolCallResultShape {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly isError?: boolean;
}

describe("SubAgentMcpServer", () => {
  describe("initialize", () => {
    it("returns capabilities.tools and serverInfo, echoing the client's requested protocolVersion", async () => {
      const projection = createProjectionStub(new Map());
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      );

      expect(Option.isSome(response)).toBe(true);
      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      expect(result.id).toBe(1);
      expect(result.result).toEqual({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "synara-subagents", version: "0.1.0" },
      });
    });

    it("defaults protocolVersion to 2025-06-18 when the client omits it", async () => {
      const projection = createProjectionStub(new Map());
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      );

      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      expect((result.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    });
  });

  describe("tools/list", () => {
    it("returns exactly spawn_agent and wait, each with a non-empty inputSchema", async () => {
      const projection = createProjectionStub(new Map());
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      );

      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const { tools } = result.result as {
        tools: ReadonlyArray<{
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
        }>;
      };
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(["spawn_agent", "wait"]);
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
      }
    });
  });

  describe("tools/call spawn_agent", () => {
    it("resolves the caller's context from the projection and calls orchestrator.spawn", async () => {
      const callerThread = makeCallerThread({
        envMode: "worktree",
        branch: "feature/x",
        worktreePath: "/tmp/wt",
      });
      const projection = createProjectionStub(new Map([[CALLER_THREAD_ID, callerThread]]));
      const orchestrator = createOrchestratorFake({
        spawnResult: Effect.succeed({ agentId: ThreadId.makeUnsafe("child-abc") }),
      });

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "spawn_agent",
            arguments: { provider: "codex", task: "Review the diff for correctness." },
          },
        },
      );

      expect(orchestrator.spawnCalls).toHaveLength(1);
      const call = orchestrator.spawnCalls[0]!;
      expect(call.caller).toEqual({
        threadId: CALLER_THREAD_ID,
        projectId: callerThread.projectId,
        canSpawn: true,
        workspace: { envMode: "worktree", worktreePath: "/tmp/wt", branch: "feature/x" },
      } satisfies SubAgentSpawnCaller);
      expect(call.input.provider).toBe("codex");
      expect(call.input.task).toBe("Review the diff for correctness.");

      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const toolResult = result.result as ToolCallResultShape;
      expect(toolResult.isError).toBeUndefined();
      expect(JSON.parse(toolResult.content[0]!.text)).toEqual({ agentId: "child-abc" });
    });

    it("returns a depth-limit tool error and does not call spawn when caller.canSpawn is false", async () => {
      const projection = createProjectionStub(new Map([[CALLER_THREAD_ID, makeCallerThread()]]));
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: false },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "spawn_agent", arguments: { provider: "codex", task: "x" } },
        },
      );

      expect(orchestrator.spawnCalls).toHaveLength(0);
      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const toolResult = result.result as ToolCallResultShape;
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content[0]!.text).toContain("depth-limit");
    });

    it("returns a tool error (not a thrown crash) for invalid arguments", async () => {
      const projection = createProjectionStub(new Map([[CALLER_THREAD_ID, makeCallerThread()]]));
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "spawn_agent", arguments: { provider: "not-a-real-provider", task: "" } },
        },
      );

      expect(orchestrator.spawnCalls).toHaveLength(0);
      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const toolResult = result.result as ToolCallResultShape;
      expect(toolResult.isError).toBe(true);
    });

    it("returns a tool error when the caller's own thread cannot be resolved from the projection", async () => {
      const projection = createProjectionStub(new Map());
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "spawn_agent", arguments: { provider: "codex", task: "x" } },
        },
      );

      expect(orchestrator.spawnCalls).toHaveLength(0);
      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const toolResult = result.result as ToolCallResultShape;
      expect(toolResult.isError).toBe(true);
    });

    it("maps a SubAgentError from orchestrator.spawn to a tool error carrying its reason and detail", async () => {
      const projection = createProjectionStub(new Map([[CALLER_THREAD_ID, makeCallerThread()]]));
      const orchestrator = createOrchestratorFake({
        spawnResult: Effect.fail(
          new SubAgentError({ reason: "provider-unavailable", detail: "gemini is not installed." }),
        ),
      });

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "spawn_agent", arguments: { provider: "gemini", task: "x" } },
        },
      );

      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const toolResult = result.result as ToolCallResultShape;
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content[0]!.text).toContain("provider-unavailable");
      expect(toolResult.content[0]!.text).toContain("gemini is not installed.");
    });
  });

  describe("tools/call wait", () => {
    it("calls orchestrator.wait and returns the envelopes as JSON text content", async () => {
      const projection = createProjectionStub(new Map([[CALLER_THREAD_ID, makeCallerThread()]]));
      const canned: SubAgentResult[] = [
        {
          agentId: ThreadId.makeUnsafe("child-abc"),
          threadId: ThreadId.makeUnsafe("child-abc"),
          provider: "codex",
          model: "gpt-5-codex",
          status: "completed",
          finalMessage: "Looks good.",
          diff: null,
          error: null,
        },
      ];
      const orchestrator = createOrchestratorFake({ waitResult: Effect.succeed(canned) });

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "wait", arguments: { agentIds: ["child-abc"] } },
        },
      );

      expect(orchestrator.waitCalls).toHaveLength(1);
      expect(orchestrator.waitCalls[0]!.agentIds).toEqual(["child-abc"]);
      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const toolResult = result.result as ToolCallResultShape;
      expect(toolResult.isError).toBeUndefined();
      expect(JSON.parse(toolResult.content[0]!.text)).toEqual(canned);
    });

    it("maps a SubAgentError from orchestrator.wait to a tool error", async () => {
      const projection = createProjectionStub(new Map([[CALLER_THREAD_ID, makeCallerThread()]]));
      const orchestrator = createOrchestratorFake({
        waitResult: Effect.fail(
          new SubAgentError({ reason: "unknown-agent", detail: "No sub-agent thread found." }),
        ),
      });

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "wait", arguments: { agentIds: ["missing-child"] } },
        },
      );

      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const toolResult = result.result as ToolCallResultShape;
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content[0]!.text).toContain("unknown-agent");
    });
  });

  describe("protocol-level dispatch", () => {
    it("returns a JSON-RPC error object for an unknown top-level method", async () => {
      const projection = createProjectionStub(new Map());
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        { jsonrpc: "2.0", id: 10, method: "not/a/real/method" },
      );

      const result = Option.getOrThrow(response) as JsonRpcErrorResponse;
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32601);
    });

    it("returns a tool error (not a protocol error) for an unknown tool name", async () => {
      const projection = createProjectionStub(new Map());
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "does_not_exist", arguments: {} },
        },
      );

      const result = Option.getOrThrow(response) as JsonRpcSuccessResponse;
      const toolResult = result.result as ToolCallResultShape;
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content[0]!.text).toContain("does_not_exist");
    });

    it("returns Option.none() for notifications (no response by protocol convention)", async () => {
      const projection = createProjectionStub(new Map());
      const orchestrator = createOrchestratorFake();

      const response = await runHandle(
        { orchestrator: orchestrator.shape, projection },
        { threadId: CALLER_THREAD_ID, canSpawn: true },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      );

      expect(Option.isNone(response)).toBe(true);
    });
  });
});
