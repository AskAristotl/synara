/**
 * SubAgentMcpServer - Transport-agnostic MCP request handler for sub-agent tools.
 *
 * Hand-rolled MCP JSON-RPC 2.0 handler (no `@modelcontextprotocol/sdk`: the
 * server runs on Effect's `HttpRouter`, and the SDK's node-req/res transport
 * does not fit that model). `handle` is pure request-in/response-out — it
 * knows nothing about HTTP, bearer tokens, or sockets. The HTTP transport
 * (`httpTransport.ts`) resolves a bearer token to a caller identity via
 * `SessionTokenRegistry` and forwards the parsed JSON body here.
 *
 * Registers all four v1 sub-agent tools (design decision 11): `spawn_agent`,
 * `wait`, `send_message`, and `stop_agent` (Task 6.1). `send_message` starts a
 * follow-up turn on a child the caller already spawned; `stop_agent` stops
 * one. Both are ownership-checked server-side by
 * `SubAgentOrchestrator.sendMessage`/`stopAgent`
 * (`orchestration/Layers/SubAgentOrchestrator.ts`'s `assertOwnership`) — a
 * caller can only target an `agentId` it spawned itself, never an arbitrary
 * thread id or another caller's child.
 *
 * Error convention (mirrors MCP conventions):
 * - TOOL errors (depth-limit, provider-unavailable, bad arguments, unknown
 *   tool) are a JSON-RPC RESULT with `{ content, isError: true }` — the model
 *   sees these as a normal tool response it can reason about and retry.
 * - PROTOCOL errors (malformed JSON-RPC envelope, unknown method) are a
 *   JSON-RPC error object (`{ error: { code, message } }`).
 *
 * Design source of truth:
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md (§3.5 MCP
 * tool contracts).
 *
 * @module SubAgentMcpServer
 */
import type { OrchestrationThread } from "@t3tools/contracts";
import {
  ProviderKind,
  SubAgentApprovalMode,
  SubAgentSendMessageInput,
  SubAgentSpawnInput,
  SubAgentStopInput,
  SubAgentWaitInput,
  SubAgentWorkspaceMode,
  SubAgentWaitMode,
} from "@t3tools/contracts";
import { SUBAGENT_WAIT_MAX_SECONDS } from "@t3tools/shared/subagent";
import { Effect, Layer, Option, Result, Schema, SchemaIssue, ServiceMap } from "effect";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  SubAgentError,
  SubAgentOrchestrator,
  type SubAgentSpawnCaller,
} from "../orchestration/Services/SubAgentOrchestrator.ts";
import type { SessionTokenIdentity } from "./SessionTokenRegistry.ts";

/** MCP protocol version echoed back when the client's `initialize` omits one. */
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "synara-subagents";
const SERVER_VERSION = "0.1.0";

// JSON-RPC 2.0 error codes (standard reserved range; see the spec's §5.1).
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_PARSE_ERROR = -32700;

export type JsonRpcId = string | number | null;

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: {
    readonly code: number;
    readonly message: string;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export function jsonRpcParseError(message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_PARSE_ERROR, message } };
}

interface McpToolTextContent {
  readonly type: "text";
  readonly text: string;
}

interface McpToolCallResult {
  readonly content: readonly McpToolTextContent[];
  readonly isError?: true;
}

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const SPAWN_AGENT_TOOL: McpToolDefinition = {
  name: "spawn_agent",
  description:
    "Spawn a bounded sub-agent (of the same or a different provider/model) to work on a " +
    "delegated task. Non-blocking: returns immediately with an { agentId } handle while the " +
    "sub-agent runs in the background. Call the 'wait' tool with the returned agentId to block " +
    "until it finishes and read its result. Depth is limited to one level — a sub-agent cannot " +
    "itself call spawn_agent.",
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: [...ProviderKind.literals],
        description:
          "Provider to run the sub-agent on, validated against installed/authed providers.",
      },
      task: {
        type: "string",
        minLength: 1,
        description: "The task/prompt handed to the sub-agent as its first turn.",
      },
      model: {
        type: "string",
        description:
          "Optional model id for the provider; defaults to that provider's default model.",
      },
      role: {
        type: "string",
        description:
          "Optional free-form label for the sub-agent's role (e.g. 'reviewer'). Display-only.",
      },
      nickname: {
        type: "string",
        description: "Optional free-form nickname shown for the sub-agent in the UI.",
      },
      workspace: {
        type: "string",
        enum: [...SubAgentWorkspaceMode.literals],
        default: "share",
        description:
          "'share' (default) runs the sub-agent in the caller's own working tree. 'worktree' " +
          "provisions an isolated git worktree for the sub-agent so it cannot touch the caller's files.",
      },
      includeWip: {
        type: "boolean",
        default: false,
        description:
          "worktree-only: snapshot the caller's uncommitted changes onto the sub-agent's worktree.",
      },
      approval: {
        type: "string",
        enum: [...SubAgentApprovalMode.literals],
        default: "auto",
        description:
          "'auto' (default) runs full-access with no human approval prompts. 'ask-human' requires " +
          "human approval for actions. 'read-only' restricts the sub-agent to read-only access.",
      },
      attachParentContext: {
        type: "boolean",
        default: false,
        description:
          "Push the caller's recent messages/diff into the sub-agent's context instead of the " +
          "default pull model (the sub-agent reads files / git diff itself).",
      },
    },
    required: ["provider", "task"],
  },
};

const WAIT_TOOL: McpToolDefinition = {
  name: "wait",
  description:
    "Block until the given sub-agent(s) (agentIds returned by spawn_agent) reach a terminal " +
    "state, or until the timeout elapses. Returns one result envelope per agentId with fields " +
    "including status, finalMessage, and diff. If a sub-agent is still working when the timeout " +
    'elapses, its envelope has status:"running" — this is a valid result, NOT an error; call ' +
    "wait again with the same agentId to keep waiting.",
  inputSchema: {
    type: "object",
    properties: {
      agentIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Handles returned by spawn_agent to wait on.",
      },
      mode: {
        type: "string",
        enum: [...SubAgentWaitMode.literals],
        default: "all",
        description:
          "'all' (default) waits for every agentId to reach a terminal state. 'any' returns as " +
          "soon as the first agentId does.",
      },
      timeoutSeconds: {
        type: "integer",
        minimum: 1,
        maximum: SUBAGENT_WAIT_MAX_SECONDS,
        description: `Max seconds to block before returning still-running agents with status:"running". Clamped to the server maximum (${SUBAGENT_WAIT_MAX_SECONDS}s); defaults to the maximum when omitted.`,
      },
    },
    required: ["agentIds"],
  },
};

const SEND_MESSAGE_TOOL: McpToolDefinition = {
  name: "send_message",
  description:
    "Send a follow-up task to a sub-agent YOU spawned (starts a new turn on that child). Only " +
    "works on an agentId returned by your own spawn_agent call — sending to any other agentId " +
    "fails with a not-owner error. Non-blocking: call the 'wait' tool again with the same agentId " +
    "to block until this follow-up turn finishes.",
  inputSchema: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Handle returned by spawn_agent for the sub-agent you spawned.",
      },
      task: {
        type: "string",
        minLength: 1,
        description: "The follow-up task/prompt handed to the sub-agent as its next turn.",
      },
    },
    required: ["agentId", "task"],
  },
};

const STOP_AGENT_TOOL: McpToolDefinition = {
  name: "stop_agent",
  description:
    "Stop a sub-agent YOU spawned. Only works on an agentId returned by your own spawn_agent call " +
    "— stopping any other agentId fails with a not-owner error. Idempotent: stopping an " +
    "already-stopped sub-agent is a safe no-op.",
  inputSchema: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Handle returned by spawn_agent for the sub-agent you spawned.",
      },
    },
    required: ["agentId"],
  },
};

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  SPAWN_AGENT_TOOL,
  WAIT_TOOL,
  SEND_MESSAGE_TOOL,
  STOP_AGENT_TOOL,
];

const decodeSpawnInput = Schema.decodeUnknownEffect(SubAgentSpawnInput);
const decodeWaitInput = Schema.decodeUnknownEffect(SubAgentWaitInput);
const decodeSendMessageInput = Schema.decodeUnknownEffect(SubAgentSendMessageInput);
const decodeStopInput = Schema.decodeUnknownEffect(SubAgentStopInput);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRpcId(value: Record<string, unknown>): JsonRpcId {
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolSuccessResult(value: unknown): McpToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** `reason` mirrors {@link SubAgentError}'s `reason` discriminant so tool-error text stays greppable. */
function toolErrorResult(reason: string, detail: string): McpToolCallResult {
  return {
    content: [{ type: "text", text: `Sub-agent operation failed (${reason}): ${detail}` }],
    isError: true,
  };
}

function formatSchemaIssue(error: Schema.SchemaError): string {
  return SchemaIssue.makeFormatterDefault()(error.issue);
}

function buildInitializeResult(params: unknown): {
  readonly protocolVersion: string;
  readonly capabilities: { readonly tools: Record<string, never> };
  readonly serverInfo: { readonly name: string; readonly version: string };
} {
  const protocolVersion =
    isRecord(params) && typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : DEFAULT_MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

/**
 * Resolve a `spawn_agent` caller's full context from the projection (decision
 * #3 in the task brief): the bearer token only gives `{threadId, canSpawn}`;
 * `projectId` and the workspace descriptor (`envMode`/`worktreePath`/`branch`)
 * come from the caller's own thread row so the child inherits the same
 * project/cwd as its parent (share-cwd, decision 5 of the design spec).
 */
function buildSpawnCaller(
  caller: SessionTokenIdentity,
  callerThread: OrchestrationThread,
): SubAgentSpawnCaller {
  return {
    threadId: caller.threadId,
    projectId: callerThread.projectId,
    canSpawn: caller.canSpawn,
    workspace: {
      // `OrchestrationThread.envMode`'s static `.Type` still carries `| undefined`
      // from `Schema.optional` even though `Schema.withDecodingDefault` guarantees
      // a runtime value ("local") -- same caveat SubAgentOrchestratorLive.ts notes
      // for `approval`. Fall back to the same default the schema decodes to.
      envMode: callerThread.envMode ?? "local",
      worktreePath: callerThread.worktreePath,
      branch: callerThread.branch,
    },
  };
}

function resolveSpawnCaller(
  projection: ProjectionSnapshotQueryShape,
  caller: SessionTokenIdentity,
): Effect.Effect<SubAgentSpawnCaller, string> {
  return projection.getThreadDetailById(caller.threadId).pipe(
    Effect.mapError(() => `Failed to read the calling session's thread '${caller.threadId}'.`),
    Effect.flatMap((threadOption) =>
      Option.isSome(threadOption)
        ? Effect.succeed(buildSpawnCaller(caller, threadOption.value))
        : Effect.fail(`No thread found for the calling session's agentId '${caller.threadId}'.`),
    ),
  );
}

export interface SubAgentMcpServerShape {
  /**
   * Handle one already-JSON-parsed MCP message for `caller`. Returns
   * `Option.none()` for JSON-RPC notifications (including `notifications/*`),
   * which have no response by protocol convention.
   */
  readonly handle: (
    caller: SessionTokenIdentity,
    message: unknown,
  ) => Effect.Effect<Option.Option<JsonRpcResponse>>;
}

export class SubAgentMcpServer extends ServiceMap.Service<
  SubAgentMcpServer,
  SubAgentMcpServerShape
>()("t3/subagentMcp/SubAgentMcpServer") {}

export const SubAgentMcpServerLive = Layer.effect(
  SubAgentMcpServer,
  Effect.gen(function* () {
    const orchestrator = yield* SubAgentOrchestrator;
    const projection = yield* ProjectionSnapshotQuery;

    const handleSpawnAgent = (
      caller: SessionTokenIdentity,
      rawArgs: unknown,
    ): Effect.Effect<McpToolCallResult> =>
      Effect.gen(function* () {
        if (!caller.canSpawn) {
          return toolErrorResult(
            "depth-limit",
            "This session cannot spawn sub-agents: only human-initiated sessions may spawn, and " +
              "sub-agents cannot spawn grandchildren.",
          );
        }

        const decoded = yield* Effect.result(decodeSpawnInput(rawArgs));
        if (Result.isFailure(decoded)) {
          return toolErrorResult("invalid-arguments", formatSchemaIssue(decoded.failure));
        }

        const spawnCaller = yield* Effect.result(resolveSpawnCaller(projection, caller));
        if (Result.isFailure(spawnCaller)) {
          return toolErrorResult("caller-unresolved", spawnCaller.failure);
        }

        const spawned = yield* Effect.result(
          orchestrator.spawn(spawnCaller.success, decoded.success),
        );
        if (Result.isFailure(spawned)) {
          const error: SubAgentError = spawned.failure;
          return toolErrorResult(error.reason, error.detail);
        }

        return toolSuccessResult({ agentId: spawned.success.agentId });
      });

    const handleWait = (rawArgs: unknown): Effect.Effect<McpToolCallResult> =>
      Effect.gen(function* () {
        const decoded = yield* Effect.result(decodeWaitInput(rawArgs));
        if (Result.isFailure(decoded)) {
          return toolErrorResult("invalid-arguments", formatSchemaIssue(decoded.failure));
        }

        const waited = yield* Effect.result(orchestrator.wait(decoded.success));
        if (Result.isFailure(waited)) {
          const error: SubAgentError = waited.failure;
          return toolErrorResult(error.reason, error.detail);
        }

        return toolSuccessResult(waited.success);
      });

    // Task 6.1: `send_message`/`stop_agent` both pass `caller` (the resolved
    // `SessionTokenIdentity`, `{threadId, canSpawn}`) straight through to the
    // orchestrator -- unlike `spawn_agent`, no projection lookup is needed
    // here to build the caller context: `SubAgentOrchestrator.sendMessage`/
    // `stopAgent` only need `caller.threadId` (see `SubAgentCaller` in
    // `orchestration/Services/SubAgentOrchestrator.ts`), which the token
    // identity already carries. Ownership itself (is `agentId` actually this
    // caller's child?) is enforced server-side by the orchestrator's
    // `assertOwnership`, not here.
    const handleSendMessage = (
      caller: SessionTokenIdentity,
      rawArgs: unknown,
    ): Effect.Effect<McpToolCallResult> =>
      Effect.gen(function* () {
        const decoded = yield* Effect.result(decodeSendMessageInput(rawArgs));
        if (Result.isFailure(decoded)) {
          return toolErrorResult("invalid-arguments", formatSchemaIssue(decoded.failure));
        }

        const sent = yield* Effect.result(orchestrator.sendMessage(caller, decoded.success));
        if (Result.isFailure(sent)) {
          const error: SubAgentError = sent.failure;
          return toolErrorResult(error.reason, error.detail);
        }

        return toolSuccessResult({ ok: true });
      });

    const handleStopAgent = (
      caller: SessionTokenIdentity,
      rawArgs: unknown,
    ): Effect.Effect<McpToolCallResult> =>
      Effect.gen(function* () {
        const decoded = yield* Effect.result(decodeStopInput(rawArgs));
        if (Result.isFailure(decoded)) {
          return toolErrorResult("invalid-arguments", formatSchemaIssue(decoded.failure));
        }

        const stopped = yield* Effect.result(orchestrator.stopAgent(caller, decoded.success));
        if (Result.isFailure(stopped)) {
          const error: SubAgentError = stopped.failure;
          return toolErrorResult(error.reason, error.detail);
        }

        return toolSuccessResult({ ok: true });
      });

    const dispatchToolCall = (
      caller: SessionTokenIdentity,
      name: string,
      args: unknown,
    ): Effect.Effect<McpToolCallResult> => {
      switch (name) {
        case SPAWN_AGENT_TOOL.name:
          return handleSpawnAgent(caller, args);
        case WAIT_TOOL.name:
          return handleWait(args);
        case SEND_MESSAGE_TOOL.name:
          return handleSendMessage(caller, args);
        case STOP_AGENT_TOOL.name:
          return handleStopAgent(caller, args);
        default:
          return Effect.succeed(toolErrorResult("unknown-tool", `No such tool '${name}'.`));
      }
    };

    const handle: SubAgentMcpServerShape["handle"] = (caller, message) =>
      Effect.gen(function* () {
        if (!isRecord(message)) {
          return Option.some(
            jsonRpcError(
              null,
              JSON_RPC_INVALID_REQUEST,
              "Malformed JSON-RPC message: expected an object.",
            ),
          );
        }

        const id = readJsonRpcId(message);
        if (typeof message.method !== "string") {
          return Option.some(
            jsonRpcError(
              id,
              JSON_RPC_INVALID_REQUEST,
              "Malformed JSON-RPC message: 'method' must be a string.",
            ),
          );
        }
        const { method } = message;

        // MCP notifications (including notifications/initialized) never get a response.
        if (method.startsWith("notifications/")) {
          return Option.none();
        }

        if (method === "initialize") {
          return Option.some(jsonRpcResult(id, buildInitializeResult(message.params)));
        }

        if (method === "tools/list") {
          return Option.some(jsonRpcResult(id, { tools: TOOL_DEFINITIONS }));
        }

        if (method === "tools/call") {
          const params = message.params;
          if (!isRecord(params) || typeof params.name !== "string") {
            return Option.some(
              jsonRpcError(
                id,
                JSON_RPC_INVALID_PARAMS,
                "tools/call requires a string 'params.name'.",
              ),
            );
          }
          const toolResult = yield* dispatchToolCall(caller, params.name, params.arguments);
          return Option.some(jsonRpcResult(id, toolResult));
        }

        return Option.some(
          jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown method '${method}'.`),
        );
      });

    return { handle } satisfies SubAgentMcpServerShape;
  }),
);
