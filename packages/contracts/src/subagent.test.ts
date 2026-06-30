import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  SubAgentApprovalMode,
  SubAgentResult,
  SubAgentResultDiff,
  SubAgentSendMessageInput,
  SubAgentSpawnInput,
  SubAgentStatus,
  SubAgentStopInput,
  SubAgentWaitInput,
  SubAgentWorkspaceMode,
} from "./subagent";

const decodeSpawnInput = Schema.decodeUnknownSync(SubAgentSpawnInput);
const decodeWaitInput = Schema.decodeUnknownSync(SubAgentWaitInput);
const decodeSendMessageInput = Schema.decodeUnknownSync(SubAgentSendMessageInput);
const decodeStopInput = Schema.decodeUnknownSync(SubAgentStopInput);
const decodeResult = Schema.decodeUnknownSync(SubAgentResult);
const decodeResultDiff = Schema.decodeUnknownSync(SubAgentResultDiff);
const decodeStatus = Schema.decodeUnknownSync(SubAgentStatus);
const decodeWorkspaceMode = Schema.decodeUnknownSync(SubAgentWorkspaceMode);
const decodeApprovalMode = Schema.decodeUnknownSync(SubAgentApprovalMode);

describe("SubAgentWorkspaceMode", () => {
  it("accepts share and worktree", () => {
    expect(decodeWorkspaceMode("share")).toBe("share");
    expect(decodeWorkspaceMode("worktree")).toBe("worktree");
  });

  it("rejects unknown values", () => {
    expect(() => decodeWorkspaceMode("isolated")).toThrow();
  });
});

describe("SubAgentApprovalMode", () => {
  it("accepts auto, ask-human, read-only", () => {
    expect(decodeApprovalMode("auto")).toBe("auto");
    expect(decodeApprovalMode("ask-human")).toBe("ask-human");
    expect(decodeApprovalMode("read-only")).toBe("read-only");
  });

  it("rejects unknown values", () => {
    expect(() => decodeApprovalMode("never")).toThrow();
  });
});

describe("SubAgentStatus", () => {
  it("accepts all known statuses", () => {
    for (const status of ["completed", "failed", "interrupted", "timeout", "running"]) {
      expect(decodeStatus(status)).toBe(status);
    }
  });

  it("rejects unknown statuses", () => {
    expect(() => decodeStatus("queued")).toThrow();
  });
});

describe("SubAgentSpawnInput", () => {
  it("round-trips a fully specified payload", () => {
    const parsed = decodeSpawnInput({
      provider: "claudeAgent",
      task: "Investigate the flaky test in auth.test.ts",
      model: "claude-sonnet-4-6",
      role: "investigator",
      nickname: "auth-sleuth",
      workspace: "worktree",
      includeWip: true,
      approval: "ask-human",
      attachParentContext: true,
    });

    expect(parsed).toEqual({
      provider: "claudeAgent",
      task: "Investigate the flaky test in auth.test.ts",
      model: "claude-sonnet-4-6",
      role: "investigator",
      nickname: "auth-sleuth",
      workspace: "worktree",
      includeWip: true,
      approval: "ask-human",
      attachParentContext: true,
    });
  });

  it("defaults workspace to share, approval to auto, includeWip and attachParentContext to false", () => {
    const parsed = decodeSpawnInput({
      provider: "codex",
      task: "Summarize open PRs",
    });

    expect(parsed.workspace).toBe("share");
    expect(parsed.approval).toBe("auto");
    expect(parsed.includeWip).toBe(false);
    expect(parsed.attachParentContext).toBe(false);
    expect(parsed.model).toBeUndefined();
    expect(parsed.role).toBeUndefined();
    expect(parsed.nickname).toBeUndefined();
  });

  it("rejects an empty task", () => {
    expect(() =>
      decodeSpawnInput({
        provider: "codex",
        task: "   ",
      }),
    ).toThrow();
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      decodeSpawnInput({
        provider: "not-a-real-provider",
        task: "Do something",
      }),
    ).toThrow();
  });
});

describe("SubAgentWaitInput", () => {
  it("round-trips a fully specified payload", () => {
    const parsed = decodeWaitInput({
      agentIds: ["thread-child-1", "thread-child-2"],
      mode: "any",
      timeoutSeconds: 120,
    });

    expect(parsed).toEqual({
      agentIds: ["thread-child-1", "thread-child-2"],
      mode: "any",
      timeoutSeconds: 120,
    });
  });

  it("defaults mode to all", () => {
    const parsed = decodeWaitInput({
      agentIds: ["thread-child-1"],
    });

    expect(parsed.mode).toBe("all");
    expect(parsed.timeoutSeconds).toBeUndefined();
  });

  it("rejects a non-array agentIds", () => {
    expect(() =>
      decodeWaitInput({
        agentIds: "thread-child-1",
      }),
    ).toThrow();
  });
});

describe("SubAgentSendMessageInput", () => {
  it("round-trips a valid payload", () => {
    const parsed = decodeSendMessageInput({
      agentId: "thread-child-1",
      task: "Now also check the integration tests",
    });

    expect(parsed).toEqual({
      agentId: "thread-child-1",
      task: "Now also check the integration tests",
    });
  });

  it("rejects an empty task", () => {
    expect(() =>
      decodeSendMessageInput({
        agentId: "thread-child-1",
        task: "",
      }),
    ).toThrow();
  });
});

describe("SubAgentStopInput", () => {
  it("round-trips a valid payload", () => {
    const parsed = decodeStopInput({ agentId: "thread-child-1" });
    expect(parsed).toEqual({ agentId: "thread-child-1" });
  });

  it("rejects a missing agentId", () => {
    expect(() => decodeStopInput({})).toThrow();
  });
});

describe("SubAgentResultDiff", () => {
  it("round-trips a valid payload", () => {
    const parsed = decodeResultDiff({
      branch: "subagent/thread-child-1",
      filesChanged: 3,
      summary: "Refactored auth middleware",
    });

    expect(parsed).toEqual({
      branch: "subagent/thread-child-1",
      filesChanged: 3,
      summary: "Refactored auth middleware",
    });
  });
});

describe("SubAgentResult", () => {
  it("round-trips a completed result with a diff", () => {
    const parsed = decodeResult({
      agentId: "thread-child-1",
      threadId: "thread-child-1",
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      status: "completed",
      finalMessage: "Done — fixed the flaky test.",
      diff: {
        branch: "subagent/thread-child-1",
        filesChanged: 2,
        summary: "Fixed flaky auth test",
      },
      error: null,
    });

    expect(parsed).toEqual({
      agentId: "thread-child-1",
      threadId: "thread-child-1",
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      status: "completed",
      finalMessage: "Done — fixed the flaky test.",
      diff: {
        branch: "subagent/thread-child-1",
        filesChanged: 2,
        summary: "Fixed flaky auth test",
      },
      error: null,
    });
  });

  it("round-trips a failed result with null diff and an error", () => {
    const parsed = decodeResult({
      agentId: "thread-child-2",
      threadId: "thread-child-2",
      provider: "codex",
      model: null,
      status: "failed",
      finalMessage: "",
      diff: null,
      error: "provider crashed during startup",
    });

    expect(parsed).toEqual({
      agentId: "thread-child-2",
      threadId: "thread-child-2",
      provider: "codex",
      model: null,
      status: "failed",
      finalMessage: "",
      diff: null,
      error: "provider crashed during startup",
    });
  });

  it("rejects an invalid status", () => {
    expect(() =>
      decodeResult({
        agentId: "thread-child-1",
        threadId: "thread-child-1",
        provider: "codex",
        model: null,
        status: "queued",
        finalMessage: "",
        diff: null,
        error: null,
      }),
    ).toThrow();
  });
});
