/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and lightweight command-state updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, PubSub, Scope, Stream } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Read the command-oriented in-memory model used by orchestration tests and
   * compatibility callers. Runtime snapshot reads should prefer
   * ProjectionSnapshotQuery.
   */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Repair project-facing projection state for older installs without clearing
   * existing chat rows.
   *
   * Replays the snapshot-related projector cursors and refreshes the in-memory
   * command model from projection state.
   */
  readonly repairState: () => Effect.Effect<
    OrchestrationReadModel,
    OrchestrationDispatchError | OrchestrationEventStoreError,
    never
  >;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /**
   * Subscribe to domain events eagerly.
   *
   * Unlike `streamDomainEvents` (a `Stream.fromPubSub` description whose
   * underlying `PubSub.subscribe` is deferred until the stream is first
   * pulled — see `Stream.toPull` / `Channel.unwrap`), this effect registers
   * the `PubSub` subscription synchronously the moment it is run. Consumers
   * that must not miss an event published between "start listening" and
   * "finish some other setup work" (e.g. `SubAgentOrchestrator.wait`, which
   * subscribes before seeding per-child state from a SQL read) should
   * `yield*` this first and drain the returned subscription afterward,
   * rather than deferring subscription via `Stream.toPull`.
   *
   * Scoped: the subscription is torn down when the acquiring scope closes.
   */
  readonly subscribeDomainEvents: Effect.Effect<
    PubSub.Subscription<OrchestrationEvent>,
    never,
    Scope.Scope
  >;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
