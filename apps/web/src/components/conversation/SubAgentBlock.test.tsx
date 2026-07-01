// FILE: SubAgentBlock.test.tsx
// Purpose: Covers SubAgentBlock's per-child rows (status label, provider/model, nickname/role)
//          and the "open thread" click wiring, without a jsdom/RTL test environment (this repo's
//          .test.tsx suite runs under vitest's default "node" environment — see MessagesTimeline
//          .test.tsx and ChatTranscriptPane.test.tsx for the same renderToStaticMarkup convention).

import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AppState } from "~/store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "~/types";
import type { ThreadSession, ThreadShell } from "~/types";

// SubAgentBlock reads live child status from the store's normalized `threadShellById` /
// `threadSessionById` slices (see SubAgentBlock.selectors.ts for why). Mock `useStore` as a
// plain selector-applier over a test-controlled state snapshot instead of standing up the real
// store (which persists to localStorage and needs a full AppState).
const storeState = vi.hoisted(() => ({
  current: {} as unknown as AppState,
}));

vi.mock("~/store", () => ({
  useStore: (selector: (state: AppState) => unknown) => selector(storeState.current),
}));

import { SubAgentBlock, SubAgentRow } from "./SubAgentBlock";
import type { ChildSubAgentThread } from "./SubAgentBlock.selectors";

const parentThreadId = ThreadId.makeUnsafe("thread-parent");
const projectId = ProjectId.makeUnsafe("project-1");

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: "codex",
    status: "running",
    orchestrationStatus: "running",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function makeShell(overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: ThreadId.makeUnsafe("thread-child"),
    codexThreadId: null,
    projectId,
    title: "Child thread",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    error: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    branch: null,
    worktreePath: null,
    parentThreadId,
    ...overrides,
  };
}

function buildState(
  shells: ThreadShell[],
  sessions: Record<string, ThreadSession | null>,
): AppState {
  return {
    threadIds: shells.map((shell) => shell.id),
    threadShellById: Object.fromEntries(shells.map((shell) => [shell.id, shell])),
    threadSessionById: sessions,
  } as unknown as AppState;
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | null {
  if (node === null || node === undefined || typeof node === "boolean") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (typeof node !== "object") {
    return null;
  }
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (predicate(element)) {
    return element;
  }
  const children = element.props?.children;
  return children === undefined ? null : findElement(children, predicate);
}

describe("SubAgentBlock", () => {
  it("renders nothing when the parent thread has no children", () => {
    storeState.current = buildState([], {});

    const markup = renderToStaticMarkup(
      <SubAgentBlock parentThreadId={parentThreadId} onOpenThread={() => {}} />,
    );

    expect(markup).toBe("");
  });

  it("renders one row per child with its status label, provider/model, and nickname/role", () => {
    const runningChildId = ThreadId.makeUnsafe("thread-child-running");
    const stoppedChildId = ThreadId.makeUnsafe("thread-child-stopped");
    const unrelatedChildId = ThreadId.makeUnsafe("thread-unrelated");

    const runningChild = makeShell({
      id: runningChildId,
      subagentNickname: "Halley",
      subagentRole: "researcher",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const stoppedChild = makeShell({
      id: stoppedChildId,
      subagentNickname: "Fenwick",
      subagentRole: "reviewer",
      modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const unrelatedChild = makeShell({
      id: unrelatedChildId,
      parentThreadId: ThreadId.makeUnsafe("thread-other-parent"),
    });

    storeState.current = buildState([runningChild, stoppedChild, unrelatedChild], {
      [runningChildId]: makeSession({ status: "running", orchestrationStatus: "running" }),
      [stoppedChildId]: makeSession({ status: "closed", orchestrationStatus: "stopped" }),
    });

    const markup = renderToStaticMarkup(
      <SubAgentBlock parentThreadId={parentThreadId} onOpenThread={() => {}} />,
    );

    // Running child: active status label + its provider/model + nickname/role.
    expect(markup).toContain("Halley");
    expect(markup).toContain("researcher");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Running");

    // Stopped child: terminal status label + its (different) provider/model + nickname/role.
    expect(markup).toContain("Fenwick");
    expect(markup).toContain("reviewer");
    expect(markup).toContain("Claude");
    expect(markup).toContain("Stopped");

    // Only the two direct children render — not the thread under a different parent.
    expect(markup.match(/Open thread/g)).toHaveLength(2);
  });

  it("fires the open action with the child's id when its row is opened", () => {
    const childId = ThreadId.makeUnsafe("thread-child-click");
    const child: ChildSubAgentThread = {
      id: childId,
      modelSelection: { provider: "gemini", model: "gemini-2.5-pro" },
      subagentNickname: "Orbit",
      subagentRole: null,
      session: makeSession({ status: "running" }),
    };
    const onOpenThread = vi.fn();

    const element = SubAgentRow({ child, onOpenThread });
    const button = findElement(element, (candidate) => candidate.type === "button");
    if (!button) {
      throw new Error("expected an 'Open thread' button in the rendered row");
    }

    (button.props as { onClick: () => void }).onClick();

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith(childId);
  });
});
