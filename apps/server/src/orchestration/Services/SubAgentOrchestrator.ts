/**
 * SubAgentOrchestrator - Cross-model sub-agent orchestration service interface.
 *
 * The architectural spine of the cross-model sub-agent feature: a caller
 * provider session (parent thread) delegates a bounded task to a sub-agent of
 * another provider. A sub-agent is a real child `OrchestrationThread` linked to
 * the caller via `parentThreadId` / `subagentAgentId` / `subagentRole` /
 * `subagentNickname`, reusing the full provider/session/turn machinery.
 *
 * Phase 1 exposes `spawn` only and is exercised directly against the
 * orchestration engine (no MCP transport yet). Later tasks add `wait`,
 * `sendMessage`, `stop`, worktree provisioning, and approval resolution to this
 * same service, so the shape is designed to be extended.
 *
 * Design source of truth:
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md (§3.3 identity,
 * §3.6 command mapping).
 *
 * @module SubAgentOrchestrator
 */
import type { ProjectId, SubAgentSpawnInput, ThreadId } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

/**
 * SubAgentErrorReason - Discriminating reason for a sub-agent operation failure.
 *
 * Starts with the failures `spawn` can produce in Phase 1. Adding a reason is a
 * one-line change here; later tasks introduce governance reasons such as
 * `"depth-limit"`, `"concurrency-limit"`, and `"not-owner"` (Task 5.2) and
 * lifecycle reasons for `wait` / `stop`.
 */
export const SubAgentErrorReason = Schema.Literals(["provider-unavailable", "dispatch-failed"]);
export type SubAgentErrorReason = typeof SubAgentErrorReason.Type;

/**
 * SubAgentError - Typed failure for sub-agent orchestration operations.
 *
 * Mirrors the tagged-error style used across the codebase (e.g.
 * `OrchestrationCommandInvariantError`, `ProviderUnsupportedError`). Carries a
 * discriminating `reason`, a human-readable `detail`, and an optional `cause`
 * so the underlying failure (provider discovery / engine dispatch) is preserved.
 */
export class SubAgentError extends Schema.TaggedErrorClass<SubAgentError>()("SubAgentError", {
  reason: SubAgentErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Sub-agent operation failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * SubAgentSpawnCaller - Identity + capability context of the spawning session.
 *
 * Resolved server-side from the caller's bearer token (never client-supplied for
 * the caller's own identity). `cwd` is the caller's working directory, reused by
 * the share-cwd workspace path. `canSpawn` reflects the depth-1 governance flag;
 * it is accepted here but not yet enforced (enforcement lands in Task 5.2).
 */
export interface SubAgentSpawnCaller {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly cwd: string | undefined;
  readonly canSpawn: boolean;
}

/**
 * SubAgentOrchestratorShape - Service API for cross-model sub-agent lifecycle.
 *
 * `wait`, `sendMessage`, and `stop` are added by later tasks.
 */
export interface SubAgentOrchestratorShape {
  /**
   * Create + start a child sub-agent for the caller and return its handle.
   *
   * Non-blocking: dispatches `thread.create` (linking the child to the caller)
   * then `thread.turn.start` (carrying `input.task` as the child's first turn).
   * Validates `input.provider` against provider discovery; an unavailable
   * provider fails with `SubAgentError` reason `"provider-unavailable"`.
   *
   * @returns The minted child `ThreadId` as `agentId` (the wait/send/stop handle).
   */
  readonly spawn: (
    caller: SubAgentSpawnCaller,
    input: SubAgentSpawnInput,
  ) => Effect.Effect<{ agentId: ThreadId }, SubAgentError>;
}

/**
 * SubAgentOrchestrator - Service tag for the sub-agent orchestrator.
 */
export class SubAgentOrchestrator extends ServiceMap.Service<
  SubAgentOrchestrator,
  SubAgentOrchestratorShape
>()("t3/orchestration/Services/SubAgentOrchestrator") {}
