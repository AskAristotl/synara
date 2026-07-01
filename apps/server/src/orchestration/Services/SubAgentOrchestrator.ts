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
import type {
  ProjectId,
  SubAgentResult,
  SubAgentSpawnInput,
  SubAgentWaitInput,
  ThreadEnvironmentMode,
  ThreadId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

/**
 * SubAgentErrorReason - Discriminating reason for a sub-agent operation failure.
 *
 * Starts with the failures `spawn` can produce in Phase 1. Adding a reason is a
 * one-line change here; a later task introduces the governance reason
 * `"not-owner"` and lifecycle reasons for `wait` / `stop`. `"depth-limit"`
 * (Task 5.2) is `spawn`'s FIRST check: `caller.canSpawn === false` fails
 * before any I/O -- defense-in-depth alongside the MCP layer
 * (`subagentMcp/SubAgentMcpServer.ts`), which already refuses to expose the
 * spawn tool to a sub-agent thread, but the orchestrator enforces depth-1
 * itself too so no other caller of `spawn` can bypass it. `"concurrency-limit"`
 * (Task 5.2) is `spawn`'s SECOND check, run only once depth-1 has passed: the
 * caller already has `SUBAGENT_MAX_LIVE_PER_ROOT` (`@t3tools/shared/subagent`)
 * LIVE children -- see `isLiveChildSession` in `Layers/SubAgentOrchestrator.ts`
 * for the exact "live" predicate -- so spawning one more would exceed the
 * per-root cap; also covers an infra failure reading the caller's live-child
 * count (the concurrency check could not be completed, so the cap cannot be
 * guaranteed and the spawn fails closed under this same reason).
 * `"model-unavailable"` covers a spawn with no explicit `model` for a provider
 * whose `getDefaultModel` has no default (e.g. `pi`) — fail fast instead of
 * dispatching a thread with a null model. `"unknown-agent"` is the `wait`
 * failure for an `agentId` that has no backing thread (no envelope can be
 * built without a provider); `"wait-failed"` covers an infra read failure
 * while collecting child state. `"worktree-failed"` covers a
 * `workspace:"worktree"` spawn (Task 4.1) that could not resolve the parent
 * project's repo root or provision the isolated Git worktree, or (Task 4.2)
 * that could not snapshot the parent's uncommitted changes for `includeWip`
 * — `spawn` fails before dispatching any command, so no half-created thread
 * is left behind. `"stop-failed"` (Task 5.3) covers an infra failure reading
 * the parent's live children while cascading a stop
 * (`cascadeStopChildren`'s `ProjectionSnapshotQuery.getShellSnapshot` read)
 * -- a per-child dispatch failure inside `stop`/`cascadeStopChildren` still
 * surfaces as `"dispatch-failed"` (the same `toDispatchError` mapping
 * `spawn` uses for its own command dispatches).
 */
export const SubAgentErrorReason = Schema.Literals([
  "provider-unavailable",
  "model-unavailable",
  "dispatch-failed",
  "unknown-agent",
  "wait-failed",
  "worktree-failed",
  "depth-limit",
  "concurrency-limit",
  "stop-failed",
]);
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
 * the caller's own identity). `workspace` is the caller thread's own
 * `envMode`/`worktreePath`/`branch` triple — exactly the fields
 * `resolveThreadWorkspaceCwd` (`@t3tools/shared/threadEnvironment`) needs to
 * resolve a cwd. The share-cwd workspace path copies these verbatim onto the
 * child thread so the child resolves to the same cwd as the caller. `canSpawn`
 * reflects the depth-1 governance flag; `spawn` (Task 5.2) enforces it as the
 * very first check, before any I/O, failing with `SubAgentError` reason
 * `"depth-limit"` when `false`.
 */
export interface SubAgentSpawnCaller {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspace: {
    readonly envMode: ThreadEnvironmentMode;
    readonly worktreePath: string | null;
    readonly branch: string | null;
  };
  readonly canSpawn: boolean;
}

/**
 * SubAgentOrchestratorShape - Service API for cross-model sub-agent lifecycle.
 *
 * `sendMessage` is added by a later task.
 */
export interface SubAgentOrchestratorShape {
  /**
   * Create + start a child sub-agent for the caller and return its handle.
   *
   * Non-blocking: dispatches `thread.create` (linking the child to the caller)
   * then `thread.turn.start` (carrying `input.task` as the child's first turn).
   *
   * Governance is enforced FIRST, before any I/O, so a rejected spawn has zero
   * side effects (Task 5.2): `caller.canSpawn === false` fails immediately with
   * reason `"depth-limit"`; otherwise the caller's live child count (see
   * `isLiveChildSession` in the `Layers` implementation) is checked against
   * `SUBAGENT_MAX_LIVE_PER_ROOT`, failing with reason `"concurrency-limit"` if
   * spawning one more would exceed it.
   *
   * Only then does it validate `input.provider` against provider discovery; an
   * unavailable provider fails with `SubAgentError` reason
   * `"provider-unavailable"`. If `input.model` is omitted and the provider has
   * no default model (e.g. `pi`), fails with reason `"model-unavailable"`
   * instead of dispatching a thread with a null model.
   *
   * @returns The minted child `ThreadId` as `agentId` (the wait/send/stop handle).
   */
  readonly spawn: (
    caller: SubAgentSpawnCaller,
    input: SubAgentSpawnInput,
  ) => Effect.Effect<{ agentId: ThreadId }, SubAgentError>;

  /**
   * Block until each requested child reaches a terminal state (or the clamped
   * timeout elapses), then return one result envelope per `agentId`.
   *
   * Subscribes to the orchestration domain-event stream BEFORE snapshotting each
   * child so a terminal event in the gap is not lost, then resolves a child when
   * its session reaches a terminal status (`error` → `"failed"`,
   * `interrupted`/`stopped` → `"interrupted"`, a finished turn → `"completed"`).
   * `mode: "all"` (default) resolves when every child is terminal; `mode: "any"`
   * resolves on the first terminal child. Children still running when the timeout
   * elapses (or when `"any"` resolves early) are returned with `status:
   * "running"` — a valid, re-waitable result, not an error.
   *
   * Results are returned in the SAME ORDER as `input.agentIds`. An `agentId` with
   * no backing thread fails the whole call with reason `"unknown-agent"`.
   * Ownership/authorization checks are a later task and are NOT performed here.
   */
  readonly wait: (
    input: SubAgentWaitInput,
  ) => Effect.Effect<readonly SubAgentResult[], SubAgentError>;

  /**
   * Stop a single child's session (Task 5.3).
   *
   * Dispatches `ThreadSessionStopCommand` for `agentId` and nothing else --
   * see `Layers/SubAgentOrchestrator.ts`'s `stop` implementation comment for
   * the "why not also dispatch an interrupt" rationale (short version: a
   * bare session-stop already drives the child's session to a terminal
   * `"stopped"` status, and a *separate* `ThreadTurnInterruptCommand` would
   * be actively unsafe for a cross-model child under the current
   * `ProviderCommandReactor` routing -- it would target the child's PARENT
   * session, not the child's own).
   *
   * Caller-agnostic: performs no ownership/authorization check. Task 6.1
   * adds the `stop_agent` MCP tool and its ownership check on top of this.
   * Stopping an already-terminal (or unknown) `agentId` is a safe no-op:
   * `thread.session.stop` only requires the thread to exist, and re-stopping
   * an already-stopped session is idempotent at the decider/reactor level.
   */
  readonly stop: (agentId: ThreadId) => Effect.Effect<void, SubAgentError>;

  /**
   * Cascade-stop every LIVE child of `parentThreadId` (Task 5.3, design
   * decision 13: "Stopping a parent cascade-stops its running children.",
   * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md).
   *
   * Enumerates the parent's children via `ProjectionSnapshotQuery.getShellSnapshot`
   * (the same lightweight read `spawn`'s per-root concurrency cap uses, Task
   * 5.2) and calls `stop` on each child whose session is still LIVE per
   * `isLiveChildSession` (`Layers/SubAgentOrchestrator.ts`) -- an
   * already-terminal child (`"stopped"`/`"error"`/`"interrupted"`, or no
   * session at all) is skipped, making a repeated call (e.g. the recursive
   * one this same stop triggers for each just-stopped child, see the
   * `SubAgentCascadeStopReactor` doc) a no-op for anything already handled.
   * A parent with no children is a no-op. Failing to read the parent's
   * children fails with reason `"stop-failed"`; a per-child dispatch
   * failure surfaces as `"dispatch-failed"` (from `stop`).
   */
  readonly cascadeStopChildren: (parentThreadId: ThreadId) => Effect.Effect<void, SubAgentError>;
}

/**
 * SubAgentOrchestrator - Service tag for the sub-agent orchestrator.
 */
export class SubAgentOrchestrator extends ServiceMap.Service<
  SubAgentOrchestrator,
  SubAgentOrchestratorShape
>()("t3/orchestration/Services/SubAgentOrchestrator") {}
