/**
 * SubAgentCascadeStopReactorLive - Layer implementation of {@link SubAgentCascadeStopReactor}.
 *
 * Task 5.3: reacts to `thread.session-stop-requested` (the event
 * `decider.ts`'s `"thread.session.stop"` case produces, `orchestration.ts`
 * line ~1873/1403) by cascade-stopping the STOPPING thread's own LIVE
 * sub-agent children via `SubAgentOrchestrator.cascadeStopChildren` (Task
 * 5.3, `Layers/SubAgentOrchestrator.ts`) -- design decision 13,
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md: "Stopping
 * a parent cascade-stops its running children."
 *
 * TRIGGER EVENT -- `thread.session-stop-requested`, not `thread.deleted`:
 * thread-DELETION cascade is explicitly out of scope for this reactor (see
 * `ThreadDeletionReactor.ts`, which reacts to `thread.deleted` and does NOT
 * cascade to children) -- this reacts purely to a session being stopped,
 * whether that's a human clicking "stop" on any thread or (recursively) this
 * very reactor stopping a child.
 *
 * TERMINATION / IDEMPOTENCY: `cascadeStopChildren` dispatches
 * `ThreadSessionStopCommand` for each of the stopping thread's currently-LIVE
 * children (Task 5.2's `isLiveChildSession` predicate), which itself produces
 * a `thread.session-stop-requested` event per child -- so this reactor reacts
 * to its OWN output, recursing one level per generation. That recursion is
 * safely bounded two independent ways: (1) depth-1 governance (Task 5.2)
 * means a child can never have children of its own, so a child's
 * `cascadeStopChildren` call reads an empty live-child list and is an
 * immediate no-op; (2) even without depth-1, `parentThreadId` is fixed at
 * `thread.create` time and thread ids are unique, so the parent/child
 * relation is a DAG, not a graph with cycles -- a cascade can never loop back
 * to an ancestor. Idempotency for an already-stopped/stopping child is
 * enforced by `cascadeStopChildren`'s own live-child filter (evaluated fresh
 * off `ProjectionSnapshotQuery.getShellSnapshot` on every call): a thread
 * whose session has already left the LIVE set is skipped, never re-stopped.
 *
 * Mirrors the reactor shape of `SubAgentApprovalResolver.ts` /
 * `ThreadDeletionReactor.ts`: subscribes to
 * `OrchestrationEngineService.streamDomainEvents`, filters by event type, and
 * processes matches through a `makeDrainableWorker` queue so `drain` gives
 * tests a deterministic "the reactor is done" signal.
 *
 * @module SubAgentCascadeStopReactorLive
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import { Cause, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SubAgentOrchestrator } from "../Services/SubAgentOrchestrator.ts";
import {
  SubAgentCascadeStopReactor,
  type SubAgentCascadeStopReactorShape,
} from "../Services/SubAgentCascadeStopReactor.ts";

type ThreadSessionStopRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.session-stop-requested" }
>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const subAgentOrchestrator = yield* SubAgentOrchestrator;

  const processEvent = Effect.fn(function* (event: ThreadSessionStopRequestedEvent) {
    yield* subAgentOrchestrator.cascadeStopChildren(event.payload.threadId);
  });

  const processEventSafely = (event: ThreadSessionStopRequestedEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("sub-agent cascade-stop reactor failed to process event", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: SubAgentCascadeStopReactorShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.session-stop-requested") {
            return Effect.void;
          }
          return worker.enqueue(event);
        }),
      );
    });

  return {
    start,
    drain: worker.drain,
  } satisfies SubAgentCascadeStopReactorShape;
});

export const SubAgentCascadeStopReactorLive = Layer.effect(SubAgentCascadeStopReactor, make);
