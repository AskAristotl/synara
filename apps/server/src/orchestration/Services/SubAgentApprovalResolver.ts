/**
 * SubAgentApprovalResolver - Sub-agent approval auto-resolution service interface.
 *
 * Task 5.1: auto-resolves approval requests for sub-agent (child) threads
 * per the policy recorded on the thread at spawn time (`subagentApproval`),
 * so a sub-agent's approval requests are resolved server-side by the spawn's
 * policy instead of blocking on a human (design decision 7,
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md).
 *
 * @module SubAgentApprovalResolver
 */
import { Effect, Scope, ServiceMap } from "effect";

/**
 * SubAgentApprovalResolverShape - Service API for the sub-agent approval
 * resolver's background worker lifecycle.
 */
export interface SubAgentApprovalResolverShape {
  /**
   * Start the resolver.
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
 * SubAgentApprovalResolver - Service tag for the sub-agent approval resolver.
 */
export class SubAgentApprovalResolver extends ServiceMap.Service<
  SubAgentApprovalResolver,
  SubAgentApprovalResolverShape
>()("t3/orchestration/Services/SubAgentApprovalResolver") {}
