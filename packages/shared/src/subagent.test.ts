// FILE: subagent.test.ts
// Purpose: Verifies the shared sub-agent constants and handle helpers
// (wait-seconds clamping, terminal-status check) used by the server
// orchestrator.
// Layer: Shared runtime utility tests
// Depends on: Vitest and subagent helpers

import { describe, expect, it } from "vitest";
import {
  clampWaitSeconds,
  isTerminalStatus,
  SUBAGENT_DIFF_SETTLE_SECONDS,
  SUBAGENT_MAX_LIVE_PER_ROOT,
  SUBAGENT_WAIT_MAX_SECONDS,
} from "./subagent";

describe("SUBAGENT_MAX_LIVE_PER_ROOT", () => {
  it("is 6", () => {
    expect(SUBAGENT_MAX_LIVE_PER_ROOT).toBe(6);
  });
});

describe("SUBAGENT_WAIT_MAX_SECONDS", () => {
  it("is 600", () => {
    expect(SUBAGENT_WAIT_MAX_SECONDS).toBe(600);
  });
});

describe("SUBAGENT_DIFF_SETTLE_SECONDS", () => {
  it("is 5", () => {
    expect(SUBAGENT_DIFF_SETTLE_SECONDS).toBe(5);
  });

  it("is well within SUBAGENT_WAIT_MAX_SECONDS", () => {
    expect(SUBAGENT_DIFF_SETTLE_SECONDS).toBeLessThan(SUBAGENT_WAIT_MAX_SECONDS);
  });
});

describe("clampWaitSeconds", () => {
  it("caps values above the max at the max", () => {
    expect(clampWaitSeconds(99999)).toBe(600);
  });

  it("falls back to the default for non-positive input", () => {
    expect(clampWaitSeconds(0)).toBe(600);
    expect(clampWaitSeconds(-5)).toBe(600);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampWaitSeconds(Number.NaN)).toBe(600);
    expect(clampWaitSeconds(Number.POSITIVE_INFINITY)).toBe(600);
  });

  it("keeps the lower boundary at 1", () => {
    expect(clampWaitSeconds(1)).toBe(1);
  });

  it("keeps the upper boundary at 600", () => {
    expect(clampWaitSeconds(600)).toBe(600);
  });

  it("floors fractional input within range", () => {
    expect(clampWaitSeconds(1.9)).toBe(1);
  });
});

describe("isTerminalStatus", () => {
  it("treats running as non-terminal", () => {
    expect(isTerminalStatus("running")).toBe(false);
  });

  it("treats completed, failed, interrupted, and timeout as terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("interrupted")).toBe(true);
    expect(isTerminalStatus("timeout")).toBe(true);
  });
});
