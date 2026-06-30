// FILE: subagent.ts
// Purpose: Shared sub-agent constants and handle helpers (wait-seconds
// clamping, terminal-status check) consumed by the server orchestrator.
// Layer: Shared runtime utility
// Exports: SUBAGENT_MAX_LIVE_PER_ROOT, SUBAGENT_WAIT_MAX_SECONDS,
// clampWaitSeconds, isTerminalStatus

import type { SubAgentStatus } from "@t3tools/contracts";

// Maximum number of concurrently-running sub-agents per root session.
export const SUBAGENT_MAX_LIVE_PER_ROOT = 6;

// Upper bound (and fallback default) for `wait` tool seconds, in seconds.
export const SUBAGENT_WAIT_MAX_SECONDS = 600;

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
