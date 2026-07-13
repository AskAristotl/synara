// FILE: SubAgentBlock.selectors.ts
// Purpose: Memoized store selector that resolves a parent thread's live child (sub-agent) threads.
// Exports: ChildSubAgentThread, createChildSubAgentThreadsSelector
// Why: `state.threads` (and `sidebarThreadSummaryById`) intentionally skip updates on the
//      hot streaming-event path (see store.ts `applyOrchestrationEventsHotPath`), so a child's
//      live session status can only be read reliably from the normalized `threadShellById` /
//      `threadSessionById` slices — the same slices ChatView.selectors.ts reads for lineage.

import type { ModelSelection, ThreadId as ThreadIdType } from "@synara/contracts";

import type { AppState } from "../../store";
import type { ThreadSession, ThreadShell } from "../../types";

export interface ChildSubAgentThread {
  id: ThreadIdType;
  modelSelection: ModelSelection;
  subagentNickname: string | null;
  subagentRole: string | null;
  session: ThreadSession | null;
}

type ChildSliceRefs = {
  shell: ThreadShell | undefined;
  session: ThreadSession | null | undefined;
};

function collectChildSliceRefs(state: AppState, threadId: ThreadIdType): ChildSliceRefs {
  return {
    shell: state.threadShellById?.[threadId],
    session: state.threadSessionById?.[threadId],
  };
}

function childSliceRefsEqual(left: ChildSliceRefs | undefined, right: ChildSliceRefs): boolean {
  return left !== undefined && left.shell === right.shell && left.session === right.session;
}

function shallowEqualThreadIds(
  left: ReadonlyArray<ThreadIdType>,
  right: ReadonlyArray<ThreadIdType>,
): boolean {
  return left.length === right.length && left.every((threadId, index) => threadId === right[index]);
}

function shallowEqualChildren(
  left: ReadonlyArray<ChildSubAgentThread>,
  right: ReadonlyArray<ChildSubAgentThread>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.id === other.id &&
        entry.modelSelection === other.modelSelection &&
        entry.subagentNickname === other.subagentNickname &&
        entry.subagentRole === other.subagentRole &&
        entry.session === other.session
      );
    })
  );
}

function buildChildResult(
  state: AppState,
  selectedThreadIds: ReadonlyArray<ThreadIdType>,
): ChildSubAgentThread[] {
  return selectedThreadIds.flatMap((threadId) => {
    const shell = state.threadShellById?.[threadId];
    if (!shell) {
      return [];
    }
    return [
      {
        id: shell.id,
        modelSelection: shell.modelSelection,
        subagentNickname: shell.subagentNickname ?? null,
        subagentRole: shell.subagentRole ?? null,
        session: state.threadSessionById?.[threadId] ?? null,
      },
    ];
  });
}

/**
 * Builds a stateful zustand selector (one instance per mounted `SubAgentBlock`) that returns
 * the live list of `parentThreadId`'s direct child threads, bailing out to the previous array
 * reference when nothing relevant changed so the component doesn't re-render on unrelated
 * store updates.
 */
export function createChildSubAgentThreadsSelector(parentThreadId: ThreadIdType | null) {
  let previousSelectedThreadIds: ThreadIdType[] = [];
  let previousSliceRefs = new Map<ThreadIdType, ChildSliceRefs>();
  let previousResult: ChildSubAgentThread[] = [];

  return (state: AppState): ChildSubAgentThread[] => {
    if (!parentThreadId) {
      if (previousResult.length === 0) {
        return previousResult;
      }
      previousSelectedThreadIds = [];
      previousSliceRefs = new Map();
      previousResult = [];
      return previousResult;
    }

    const threadIds: readonly ThreadIdType[] = state.threadIds ?? [];
    const threadShellById: Record<ThreadIdType, ThreadShell> = state.threadShellById ?? {};
    const selectedThreadIds = threadIds.filter(
      (threadId) => threadShellById[threadId]?.parentThreadId === parentThreadId,
    );

    const selectedIdsChanged = !shallowEqualThreadIds(previousSelectedThreadIds, selectedThreadIds);
    const nextSliceRefs = new Map<ThreadIdType, ChildSliceRefs>();
    let sliceRefsChanged = selectedIdsChanged;

    for (const threadId of selectedThreadIds) {
      const nextRefs = collectChildSliceRefs(state, threadId);
      nextSliceRefs.set(threadId, nextRefs);
      if (!sliceRefsChanged && !childSliceRefsEqual(previousSliceRefs.get(threadId), nextRefs)) {
        sliceRefsChanged = true;
      }
    }

    if (!selectedIdsChanged && !sliceRefsChanged) {
      return previousResult;
    }

    previousSelectedThreadIds = selectedThreadIds;
    previousSliceRefs = nextSliceRefs;

    const nextResult = buildChildResult(state, selectedThreadIds);
    if (shallowEqualChildren(previousResult, nextResult)) {
      return previousResult;
    }

    previousResult = nextResult;
    return previousResult;
  };
}
