import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

/**
 * Sub-agent MCP I/O + result-envelope schemas.
 *
 * These describe the boundary of the cross-model sub-agent MCP server: the
 * tool inputs a caller session sends (`spawn_agent`, `wait`, `send_message`,
 * `stop_agent`) and the result envelope `wait` returns for each spawned
 * child. Field shapes mirror docs/superpowers/specs/2026-06-30-cross-model-agents-design.md
 * §3.4 (Result envelope) and §3.5 (MCP tool contracts) exactly.
 */

export const SubAgentWorkspaceMode = Schema.Literals(["share", "worktree"]);
export type SubAgentWorkspaceMode = typeof SubAgentWorkspaceMode.Type;

export const SubAgentApprovalMode = Schema.Literals(["auto", "ask-human", "read-only"]);
export type SubAgentApprovalMode = typeof SubAgentApprovalMode.Type;

export const SubAgentWaitMode = Schema.Literals(["all", "any"]);
export type SubAgentWaitMode = typeof SubAgentWaitMode.Type;

export const SubAgentStatus = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "timeout",
  "running",
]);
export type SubAgentStatus = typeof SubAgentStatus.Type;

// spawn_agent — non-blocking; creates + starts a child sub-agent.
export const SubAgentSpawnInput = Schema.Struct({
  provider: ProviderKind,
  task: TrimmedNonEmptyString,
  model: Schema.optional(TrimmedNonEmptyString),
  role: Schema.optional(TrimmedNonEmptyString),
  nickname: Schema.optional(TrimmedNonEmptyString),
  workspace: Schema.optional(SubAgentWorkspaceMode).pipe(Schema.withDecodingDefault(() => "share")),
  includeWip: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  approval: Schema.optional(SubAgentApprovalMode).pipe(Schema.withDecodingDefault(() => "auto")),
  attachParentContext: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
});
export type SubAgentSpawnInput = typeof SubAgentSpawnInput.Type;

// wait — blocking; returns envelopes for the given handles.
export const SubAgentWaitInput = Schema.Struct({
  agentIds: Schema.Array(ThreadId),
  mode: Schema.optional(SubAgentWaitMode).pipe(Schema.withDecodingDefault(() => "all")),
  timeoutSeconds: Schema.optional(PositiveInt),
});
export type SubAgentWaitInput = typeof SubAgentWaitInput.Type;

// send_message — follow-up turn to a child the caller spawned; then wait again.
export const SubAgentSendMessageInput = Schema.Struct({
  agentId: ThreadId,
  task: TrimmedNonEmptyString,
});
export type SubAgentSendMessageInput = typeof SubAgentSendMessageInput.Type;

// stop_agent — interrupt + stop a child the caller spawned.
export const SubAgentStopInput = Schema.Struct({
  agentId: ThreadId,
});
export type SubAgentStopInput = typeof SubAgentStopInput.Type;

// Present for isolated writers (worktree workspace) that produced a checkpoint.
export const SubAgentResultDiff = Schema.Struct({
  branch: TrimmedNonEmptyString,
  filesChanged: NonNegativeInt,
  summary: Schema.String,
});
export type SubAgentResultDiff = typeof SubAgentResultDiff.Type;

export const SubAgentResult = Schema.Struct({
  agentId: ThreadId, // child threadId
  threadId: ThreadId, // same as agentId; explicit for clarity
  provider: ProviderKind,
  model: Schema.NullOr(TrimmedNonEmptyString),
  status: SubAgentStatus,
  finalMessage: Schema.String, // child's last assistant message (may be partial on failure)
  diff: Schema.NullOr(SubAgentResultDiff),
  error: Schema.NullOr(Schema.String),
});
export type SubAgentResult = typeof SubAgentResult.Type;
