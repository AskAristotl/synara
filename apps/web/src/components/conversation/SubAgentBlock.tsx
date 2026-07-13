// FILE: SubAgentBlock.tsx
// Purpose: Compact block listing a thread's spawned sub-agents (status, provider/model,
//          nickname/role) inline in the parent conversation transcript.
// Exports: SubAgentBlock
// Depends on: `~/store` (live thread shell/session slices), `~/lib/subagentPresentation`
//   (shared nickname/role/accent-color resolution — see also MessagesTimeline's inline
//   subagent rows, which this block's visual language mirrors).

import { PROVIDER_DISPLAY_NAMES, type ProviderKind, type ThreadId } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import { useMemo } from "react";

import { resolveSubagentPresentation } from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import type { ThreadSession } from "~/types";

import { ChatColumnBannerFrame } from "../chat/ChatColumnBannerFrame";
import { ProviderIcon } from "../ProviderIcon";
import {
  type ChildSubAgentThread,
  createChildSubAgentThreadsSelector,
} from "./SubAgentBlock.selectors";

export type SubAgentSessionStatusKind = "active" | "terminal";

export interface SubAgentSessionStatus {
  kind: SubAgentSessionStatusKind;
  label: string;
  dotClassName: string;
  chipClassName: string;
}

// Mirrors the color palette MessagesTimeline's inline subagent rows use for status pills,
// so a sub-agent reads the same whether it's shown inline in a turn or in this block.
const ACTIVE_DOT_CLASS_NAME = "bg-sky-300/95";
const TERMINAL_DOT_CLASS_NAME = "bg-muted-foreground/22";
const ACTIVE_CHIP_CLASS_NAME = "border-sky-500/18 bg-sky-500/8 text-sky-200/90";
const ERROR_CHIP_CLASS_NAME = "border-rose-500/18 bg-rose-500/8 text-rose-200/90";
const STOPPED_CHIP_CLASS_NAME = "border-amber-500/18 bg-amber-500/8 text-amber-200/90";

/** Derives a status chip (label + color) from a child thread's session. */
export function deriveSubAgentSessionStatus(
  session: ThreadSession | null | undefined,
): SubAgentSessionStatus {
  if (!session) {
    return {
      kind: "terminal",
      label: "Stopped",
      dotClassName: TERMINAL_DOT_CLASS_NAME,
      chipClassName: STOPPED_CHIP_CLASS_NAME,
    };
  }

  switch (session.status) {
    case "running":
      return {
        kind: "active",
        label: "Running",
        dotClassName: ACTIVE_DOT_CLASS_NAME,
        chipClassName: ACTIVE_CHIP_CLASS_NAME,
      };
    case "ready":
      return {
        kind: "active",
        label: "Ready",
        dotClassName: ACTIVE_DOT_CLASS_NAME,
        chipClassName: ACTIVE_CHIP_CLASS_NAME,
      };
    case "connecting":
      return {
        kind: "active",
        label: "Connecting",
        dotClassName: ACTIVE_DOT_CLASS_NAME,
        chipClassName: ACTIVE_CHIP_CLASS_NAME,
      };
    case "error":
      return {
        kind: "terminal",
        label: "Error",
        dotClassName: TERMINAL_DOT_CLASS_NAME,
        chipClassName: ERROR_CHIP_CLASS_NAME,
      };
    case "closed":
    case "disconnected":
      return {
        kind: "terminal",
        label: "Stopped",
        dotClassName: TERMINAL_DOT_CLASS_NAME,
        chipClassName: STOPPED_CHIP_CLASS_NAME,
      };
  }
}

function subAgentModelLabel(provider: ProviderKind, model: string): string {
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  const modelLabel = formatModelDisplayName(model) ?? model;
  return `${providerLabel} • ${modelLabel}`;
}

// Pure/no-hook by design: SubAgentBlock's tests call this directly (bypassing React's
// renderer) to assert the "open thread" click wiring without a DOM test environment.
export function SubAgentRow({
  child,
  onOpenThread,
}: {
  child: ChildSubAgentThread;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const presentation = resolveSubagentPresentation({
    nickname: child.subagentNickname,
    role: child.subagentRole,
    fallbackId: child.id,
  });
  const status = deriveSubAgentSessionStatus(child.session);

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border/28 bg-background/82 px-[11px] py-2">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", status.dotClassName)}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[13px] font-semibold leading-[18px] text-foreground/90"
          title={presentation.fullLabel}
        >
          <span style={{ color: presentation.accentColor }}>{presentation.primaryLabel}</span>
          {presentation.role ? (
            <span className="ml-1 text-[11px] font-medium text-muted-foreground/48">
              ({presentation.role})
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[11px] leading-4 text-muted-foreground/56">
          <ProviderIcon provider={child.modelSelection.provider} className="size-3 shrink-0" />
          <span className="truncate">
            {subAgentModelLabel(child.modelSelection.provider, child.modelSelection.model)}
          </span>
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium tracking-[0.08em]",
          status.chipClassName,
        )}
      >
        {status.label}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-full border border-border/45 px-2.5 py-1 text-[9px] font-medium text-muted-foreground/62 transition-colors hover:border-foreground/15 hover:text-foreground/84"
        onClick={() => onOpenThread(child.id)}
      >
        Open thread
      </button>
    </div>
  );
}

export interface SubAgentBlockProps {
  parentThreadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}

/**
 * Renders a compact block above the transcript listing `parentThreadId`'s spawned sub-agent
 * threads, column-aligned the same way as the provider-health/error/rate-limit banners above
 * it. Renders nothing when the thread has no children.
 */
export function SubAgentBlock({ parentThreadId, onOpenThread }: SubAgentBlockProps) {
  const children = useStore(
    useMemo(() => createChildSubAgentThreadsSelector(parentThreadId), [parentThreadId]),
  );

  if (children.length === 0) {
    return null;
  }

  return (
    <ChatColumnBannerFrame>
      <div
        className="space-y-[5px] rounded-[14px] border border-border/45 bg-background/50 px-3 py-[9px] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
        data-testid="subagent-block"
      >
        <div className="px-0.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/50 uppercase">
          Subagents
        </div>
        {children.map((child) => (
          <SubAgentRow key={child.id} child={child} onOpenThread={onOpenThread} />
        ))}
      </div>
    </ChatColumnBannerFrame>
  );
}
