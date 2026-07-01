import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderKind,
  ProviderRequestKind,
  ProviderReviewTarget,
  ProviderSandboxMode,
  ProviderStartOptions,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderKind,
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

/**
 * ProviderSubagentMcpConfig - Loopback sub-agent MCP endpoint + bearer token
 * handed to a provider session at start so its adapter can wire spawn_agent /
 * wait / send_message / stop_agent tool calls back to the sub-agent MCP
 * server (see docs/superpowers/specs/2026-06-30-cross-model-agents-design.md
 * §3.2/§3.3). Populated by `ProviderService`, consumed by provider adapters.
 */
export const ProviderSubagentMcpConfig = Schema.Struct({
  url: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
});
export type ProviderSubagentMcpConfig = typeof ProviderSubagentMcpConfig.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderKind),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  /**
   * Whether this session may spawn sub-agents: true for a root/human-initiated
   * thread, false for a sub-agent thread. Set by the caller (orchestration
   * side) from `parentThreadId == null`. Absent is treated as `false` — only
   * explicitly-root sessions can spawn.
   */
  canSpawn: Schema.optional(Schema.Boolean),
  /**
   * Sub-agent MCP endpoint + bearer token for this session. Populated by
   * `ProviderService.startSession`, not supplied by callers.
   */
  subagentMcp: Schema.optional(ProviderSubagentMcpConfig),
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;
export const ProviderSteerTurnInput = ProviderSendTurnInput;
export type ProviderSteerTurnInput = typeof ProviderSteerTurnInput.Type;

export const ProviderForkThreadInput = Schema.Struct({
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  sourceResumeCursor: Schema.optional(Schema.Unknown),
  sourceCwd: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
});
export type ProviderForkThreadInput = typeof ProviderForkThreadInput.Type;

export const ProviderForkThreadResult = Schema.Struct({
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderForkThreadResult = typeof ProviderForkThreadResult.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderStartReviewInput = Schema.Struct({
  threadId: ThreadId,
  target: ProviderReviewTarget,
});
export type ProviderStartReviewInput = typeof ProviderStartReviewInput.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderCompactThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderCompactThreadInput = typeof ProviderCompactThreadInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  parentTurnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
  providerParentThreadId: Schema.optional(TrimmedNonEmptyString),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
