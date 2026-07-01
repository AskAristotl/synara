/**
 * SubAgentCascadeStopReactor - Cascade-stop background reactor service interface.
 *
 * Task 5.3: when a thread's session is stopped, cascade-stop its LIVE
 * sub-agent children too, so a stopped parent never leaves orphaned children
 * still running (design decision 13,
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md: "Stopping
 * a parent cascade-stops its running children.").
 *
 * @module SubAgentCascadeStopReactor
 */
import { Effect, Scope, ServiceMap } from "effect";

/**
 * SubAgentCascadeStopReactorShape - Service API for the cascade-stop
 * reactor's background worker lifecycle.
 */
export interface SubAgentCascadeStopReactorShape {
  /**
   * Start the reactor.
   *
   * The returned effect must be run in a scope so the background worker
   * fiber is finalized on shutdown. Consumes orchestration domain events via
   * an internal queue.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * SubAgentCascadeStopReactor - Service tag for the cascade-stop reactor.
 */
export class SubAgentCascadeStopReactor extends ServiceMap.Service<
  SubAgentCascadeStopReactor,
  SubAgentCascadeStopReactorShape
>()("t3/orchestration/Services/SubAgentCascadeStopReactor") {}
