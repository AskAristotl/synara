/**
 * SubAgentApprovalResolverLive - Layer implementation of {@link SubAgentApprovalResolver}.
 *
 * Auto-resolves approval requests for sub-agent (child) threads per the
 * policy recorded on the thread at spawn time (`subagentApproval`, Task 5.1;
 * design decision 7,
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md: "Approvals
 * = explicit knob, default `auto` (full-access, server-resolved)... Sub-agent
 * approval requests are resolved server-side by the spawn's policy (no
 * human prompt by default) and remain visible in the child thread."):
 *
 * - `auto` -> dispatches `ThreadApprovalRespondCommand { decision: "accept" }`.
 * - `read-only` -> dispatches `{ decision: "decline" }` (providers only ever
 *   raise a request for writes/exec under `runtimeMode: "approval-required"`
 *   -- plain reads proceed without one -- so declining every request is what
 *   makes `read-only` effectively read-only; see `SubAgentOrchestrator.ts`'s
 *   `runtimeModeForApproval`).
 * - `ask-human` -> does nothing; the request is left for a human to answer,
 *   same as a non-sub-agent thread today.
 * - `subagentApproval: null` (not a sub-agent thread) -> does nothing.
 *
 * TRIGGER EVENT -- read this before changing it: this reacts to
 * `thread.activity-appended` events whose `activity.kind ===
 * "approval.requested"`, NOT `thread.approval-response-requested` (the name
 * a first read of the domain-event union suggests). Traced end to end:
 * `ProviderRuntimeIngestion.ts`'s `runtimeEventToActivities` turns a
 * provider's `request.opened` runtime event into an `approval.requested`
 * activity, dispatched via a `thread.activity.append` command;
 * `decider.ts`'s `"thread.activity.append"` case turns that into the
 * `thread.activity-appended` event this reactor consumes. This is also
 * exactly the signal `ProjectionPipeline.ts`'s
 * `applyPendingApprovalsProjection` uses to create the PENDING
 * pending-approval row. `thread.approval-response-requested`, by contrast,
 * is emitted by `decider.ts`'s `"thread.approval.respond"` case -- i.e. only
 * AFTER a decision already exists (dispatched by a human via
 * `ChatView.tsx`'s `onRespondToApproval`, or by this very reactor) -- and is
 * consumed by `ProviderCommandReactor.ts` to forward that decision to the
 * provider process, and by `applyPendingApprovalsProjection` to mark the
 * pending-approval row RESOLVED. Reacting to it here would never see a
 * genuinely fresh request (nothing dispatches `thread.approval.respond`
 * before a decision exists) and would risk reacting to this reactor's own
 * output.
 *
 * Mirrors the reactor shape of `ThreadDeletionReactor.ts` (the lightest
 * sibling reactor): subscribes to `OrchestrationEngineService.streamDomainEvents`,
 * filters by event type, and processes matches through a `makeDrainableWorker`
 * queue so `drain` gives tests a deterministic "the reactor is done" signal.
 *
 * @module SubAgentApprovalResolverLive
 */
import {
  type ApprovalRequestId,
  CommandId,
  type OrchestrationEvent,
  type ProviderApprovalDecision,
} from "@synara/contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@synara/shared/DrainableWorker";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SubAgentApprovalResolver,
  type SubAgentApprovalResolverShape,
} from "../Services/SubAgentApprovalResolver.ts";

type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

/** Mirrors `ProjectionPipeline.ts`'s private `extractActivityRequestId`. */
function extractRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

/**
 * The auto-resolution decision for a sub-agent's approval request, or `null`
 * when the request must be left alone: `subagentApproval` is `null` (not a
 * sub-agent thread -- a human handles it as today) or `"ask-human"`
 * (explicitly deferred to a human).
 */
function decisionForApproval(
  subagentApproval: "auto" | "ask-human" | "read-only" | null,
): ProviderApprovalDecision | null {
  switch (subagentApproval) {
    case "auto":
      return "accept";
    case "read-only":
      return "decline";
    case "ask-human":
    case null:
      return null;
  }
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // Guards against dispatching more than one response for the same
  // requestId. ProjectionSnapshotQuery exposes no per-request
  // pending/resolved lookup, so this in-memory record (scoped to this
  // resolver instance's lifetime) is the guard: a duplicate/replayed
  // `approval.requested` activity for a requestId already answered is a
  // no-op rather than a second dispatch.
  const respondedRequestIds = new Set<ApprovalRequestId>();

  const dispatchDecision = (input: {
    readonly threadId: ThreadActivityAppendedEvent["payload"]["threadId"];
    readonly requestId: ApprovalRequestId;
    readonly decision: ProviderApprovalDecision;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.approval.respond",
      commandId: serverCommandId("subagent-approval-resolver"),
      threadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision,
      createdAt: new Date().toISOString(),
    });

  const processEvent = Effect.fn(function* (event: ThreadActivityAppendedEvent) {
    const { activity } = event.payload;
    if (activity.kind !== "approval.requested") {
      return;
    }
    const requestIdText = extractRequestId(activity.payload);
    if (requestIdText === null) {
      return;
    }
    const requestId = requestIdText as ApprovalRequestId;
    if (respondedRequestIds.has(requestId)) {
      return;
    }

    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
    if (Option.isNone(threadOption)) {
      return;
    }
    const decision = decisionForApproval(threadOption.value.subagentApproval ?? null);
    if (decision === null) {
      return;
    }

    // Recorded before dispatch, not after: the guard exists to skip a
    // duplicate/replayed activity for a requestId this resolver has already
    // acted on, not to retry a failed dispatch (processEventSafely below
    // logs and drops dispatch failures rather than retrying them).
    respondedRequestIds.add(requestId);
    yield* dispatchDecision({ threadId: event.payload.threadId, requestId, decision });
  });

  const processEventSafely = (event: ThreadActivityAppendedEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("sub-agent approval resolver failed to process event", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: SubAgentApprovalResolverShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.activity-appended") {
            return Effect.void;
          }
          return worker.enqueue(event);
        }),
      );
    });

  return {
    start,
    drain: worker.drain,
  } satisfies SubAgentApprovalResolverShape;
});

export const SubAgentApprovalResolverLive = Layer.effect(SubAgentApprovalResolver, make);
