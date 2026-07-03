/**
 * events - projection of orchestration domain events onto the task API's
 * external event union.
 *
 * The task API exposes a cursor over the durable orchestration event log
 * (`OrchestrationEventStore.readFromSequence`), filtered to the task's thread.
 * External dispatchers do not need the full internal event vocabulary, so this
 * module maps each relevant `OrchestrationEvent` onto a minimal union:
 *
 * - `assistant-message`: a FINAL assistant message (streaming deltas are
 *   dropped — `thread.message-sent` with `streaming: true` is token-level
 *   noise that would flood a polling client).
 * - `activity`: tool/approval/info/error activity summaries
 *   (`thread.activity-appended`). Approval requests surface here with
 *   `tone: "approval"` and, when available, the `approvalId` to respond with.
 * - `approval-resolved` / `user-input-resolved`: a response was recorded for a
 *   pending approval or user-input request.
 * - `turn-diff`: a completed turn checkpoint with its changed files.
 * - `pr-updated`: the thread's last known pull request changed.
 *
 * Everything not listed (user echoes, markers, session bookkeeping, ...) maps
 * to `null` and is skipped; the caller still advances its cursor past those
 * sequences. Run status transitions intentionally do NOT appear here — they
 * live on the AutomationRun row and are returned as a per-poll snapshot by the
 * events endpoint instead (lossless for a poller, and there is no terminal
 * domain event to forward; see `AutomationService.reconcileThread`).
 *
 * @module events
 */
import type {
  ApprovalRequestId,
  OrchestrationCheckpointFile,
  OrchestrationEvent,
  OrchestrationThreadActivityTone,
  OrchestrationThreadPullRequest,
  ProviderApprovalDecision,
} from "@t3tools/contracts";

export type TaskEvent =
  | {
      readonly type: "assistant-message";
      readonly sequence: number;
      readonly turnId: string | null;
      readonly text: string;
    }
  | {
      readonly type: "activity";
      readonly sequence: number;
      readonly tone: OrchestrationThreadActivityTone;
      readonly kind: string;
      readonly summary: string;
      readonly approvalId?: ApprovalRequestId;
    }
  | {
      readonly type: "approval-resolved";
      readonly sequence: number;
      readonly approvalId: ApprovalRequestId;
      readonly decision: ProviderApprovalDecision;
    }
  | {
      readonly type: "user-input-resolved";
      readonly sequence: number;
      readonly approvalId: ApprovalRequestId;
    }
  | {
      readonly type: "turn-diff";
      readonly sequence: number;
      readonly turnId: string;
      readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
    }
  | {
      readonly type: "pr-updated";
      readonly sequence: number;
      readonly pr: OrchestrationThreadPullRequest | null;
    };

/** Map one domain event onto the external task-event union, or `null` to skip it. */
export function toTaskEvent(event: OrchestrationEvent): TaskEvent | null {
  switch (event.type) {
    case "thread.message-sent": {
      if (event.payload.role !== "assistant" || event.payload.streaming) return null;
      return {
        type: "assistant-message",
        sequence: event.sequence,
        turnId: event.payload.turnId,
        text: event.payload.text,
      };
    }
    case "thread.activity-appended": {
      const activity = event.payload.activity;
      const approvalId = event.metadata.requestId;
      return {
        type: "activity",
        sequence: event.sequence,
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        ...(approvalId ? { approvalId } : {}),
      };
    }
    case "thread.approval-response-requested":
      return {
        type: "approval-resolved",
        sequence: event.sequence,
        approvalId: event.payload.requestId,
        decision: event.payload.decision,
      };
    case "thread.user-input-response-requested":
      return {
        type: "user-input-resolved",
        sequence: event.sequence,
        approvalId: event.payload.requestId,
      };
    case "thread.turn-diff-completed":
      return {
        type: "turn-diff",
        sequence: event.sequence,
        turnId: event.payload.turnId,
        files: event.payload.files,
      };
    case "thread.meta-updated": {
      if (event.payload.lastKnownPr === undefined) return null;
      return {
        type: "pr-updated",
        sequence: event.sequence,
        pr: event.payload.lastKnownPr,
      };
    }
    default:
      return null;
  }
}
