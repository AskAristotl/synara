// FILE: subagent.ts
// Purpose: Shared sub-agent constants and handle helpers (wait-seconds
// clamping, terminal-status check) consumed by the server orchestrator.
// Layer: Shared runtime utility
// Exports: SUBAGENT_MAX_LIVE_PER_ROOT, SUBAGENT_WAIT_MAX_SECONDS,
// SUBAGENT_DIFF_SETTLE_SECONDS, clampWaitSeconds, isTerminalStatus

import type { SubAgentStatus } from "@synara/contracts";

// Maximum number of concurrently-running sub-agents per root session.
export const SUBAGENT_MAX_LIVE_PER_ROOT = 6;

// Upper bound (and fallback default) for `wait` tool seconds, in seconds.
export const SUBAGENT_WAIT_MAX_SECONDS = 600;

// Grace window (seconds) `wait` briefly settles for, after a worktree child
// (envMode:"worktree" with a resolved branch) reaches terminal "completed"
// via session-idle, before building its result envelope -- giving
// CheckpointReactor (an independent, concurrently-forked consumer of the same
// domain-event stream that does real git I/O) a chance to land the child's
// file-bearing checkpoint so `diff` isn't usually null for the mainline
// "spawn -> edit -> report" worktree pattern. The effective settle window a
// given child gets is `min(SUBAGENT_DIFF_SETTLE_SECONDS, remaining overall
// wait timeout)` -- it never extends `wait`'s total bound past the caller's
// (clamped) `timeoutSeconds`. See `SubAgentOrchestratorLive.wait`
// (apps/server/src/orchestration/Layers/SubAgentOrchestrator.ts).
export const SUBAGENT_DIFF_SETTLE_SECONDS = 5;

// Clamps a requested wait duration (seconds) to [1, SUBAGENT_WAIT_MAX_SECONDS].
// Non-finite or non-positive input falls back to the default max rather than
// rounding up to 1, since callers passing 0/NaN almost always mean "no
// explicit timeout" rather than "wait as briefly as possible".
export function clampWaitSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return SUBAGENT_WAIT_MAX_SECONDS;
  }
  return Math.max(1, Math.min(SUBAGENT_WAIT_MAX_SECONDS, Math.floor(seconds)));
}

// Terminal statuses are every status except "running": the sub-agent has
// stopped producing events and its result envelope is final.
export function isTerminalStatus(status: SubAgentStatus): boolean {
  return status !== "running";
}
