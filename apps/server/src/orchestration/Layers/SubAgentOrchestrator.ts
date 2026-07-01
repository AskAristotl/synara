/**
 * SubAgentOrchestratorLive - Layer implementation of {@link SubAgentOrchestrator}.
 *
 * `spawn` validates the provider via discovery, resolves a model, mints a
 * child thread, and dispatches `thread.create` + `thread.turn.start` through
 * {@link OrchestrationEngineService}. The command construction mirrors
 * `automation/Layers/AutomationService.ts` (the same server-side "create a
 * thread and start its first turn" flow).
 *
 * The child's workspace (`envMode`/`worktreePath`/`branch`) depends on
 * `input.workspace`:
 * - `"share"` copies `caller.workspace` verbatim so `resolveThreadWorkspaceCwd`
 *   (`@t3tools/shared/threadEnvironment`) resolves the child to the same cwd as
 *   the caller (decision 5, "share parent cwd" —
 *   docs/superpowers/specs/2026-06-30-cross-model-agents-design.md §3.3/§5).
 * - `"worktree"` (Task 4.1) provisions a REAL isolated Git worktree via
 *   {@link GitCore}.createWorktree, branching from the parent project's
 *   current HEAD (decision 10). See {@link resolveWorktreeWorkspace}.
 *   `input.includeWip` (Task 4.2) snapshots the parent's uncommitted changes
 *   onto that branch instead: {@link GitCore}.snapshotWorkingTree produces a
 *   dangling commit containing the parent's dirty tree WITHOUT touching the
 *   parent's real working tree/index/stash, and the worktree branches from
 *   that commit rather than bare HEAD. `includeWip` only applies to
 *   `"worktree"` -- it is ignored for `"share"`.
 *
 * @module SubAgentOrchestratorLive
 */
import { randomUUID } from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ModelSelection,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderKind,
  type RuntimeMode,
  type SubAgentApprovalMode,
  type SubAgentResult,
  type SubAgentSpawnInput,
  type SubAgentStatus,
  type ThreadEnvironmentMode,
  ThreadId,
} from "@t3tools/contracts";
import { Deferred, Duration, Effect, Layer, Option, PubSub } from "effect";

import { getDefaultModel } from "@t3tools/shared/model";
import { clampWaitSeconds, SUBAGENT_WAIT_MAX_SECONDS } from "@t3tools/shared/subagent";

import type { OrchestrationDispatchError } from "../Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SubAgentError,
  SubAgentOrchestrator,
  type SubAgentOrchestratorShape,
  type SubAgentSpawnCaller,
} from "../Services/SubAgentOrchestrator.ts";

const SUBAGENT_TITLE_MAX_CHARS = 80;

/**
 * Build the per-provider `ModelSelection` variant for a spawn. `ModelSelection`
 * is a discriminated union keyed on `provider`; a switch over the (exhaustive)
 * `ProviderKind` literal narrows `provider` per-branch so each returned object
 * is checked by the compiler against the matching union member — no
 * `as ModelSelection` escape hatch. `model` must already be resolved
 * (non-null); callers resolve-or-fail via {@link resolveSubAgentModel} first.
 */
function buildModelSelection(provider: ProviderKind, model: string): ModelSelection {
  switch (provider) {
    case "codex":
      return { provider, model };
    case "claudeAgent":
      return { provider, model };
    case "cursor":
      return { provider, model };
    case "gemini":
      return { provider, model };
    case "grok":
      return { provider, model };
    case "kilo":
      return { provider, model };
    case "opencode":
      return { provider, model };
    case "pi":
      return { provider, model };
    default:
      provider satisfies never;
      throw new Error(`Unhandled provider kind: ${provider as string}`);
  }
}

/**
 * Resolve the model for a spawn: the caller's explicit `model`, or else the
 * provider's default (`getDefaultModel`). Returns `null` when neither is
 * available (e.g. `pi`, which has no default model) so the caller can fail
 * fast with `SubAgentError` reason `"model-unavailable"` instead of
 * dispatching a `thread.create` with a null model.
 */
function resolveSubAgentModel(provider: ProviderKind, model: string | undefined): string | null {
  return model ?? getDefaultModel(provider);
}

/**
 * Map a spawn's `approval` knob to a thread `runtimeMode`.
 *
 * TODO(Task 5.1): real approval resolution. `auto` and `read-only` both run
 * `full-access` for now (no sandboxed read-only runtime yet); `ask-human` uses
 * `approval-required` so requests surface instead of being auto-resolved.
 * Accepts `undefined` because `SubAgentSpawnInput.approval`'s static `.Type`
 * still carries `| undefined` from `Schema.optional` even though
 * `Schema.withDecodingDefault` guarantees a runtime value (`"auto"`) — treat
 * `undefined` the same as `"auto"`.
 */
function runtimeModeForApproval(approval: SubAgentApprovalMode | undefined): RuntimeMode {
  return approval === "ask-human" ? "approval-required" : "full-access";
}

/** A concise, non-empty thread title derived from the spawn's labels/task. */
function deriveSubAgentTitle(input: SubAgentSpawnInput): string {
  const source = (input.nickname ?? input.role ?? input.task).trim();
  const title =
    source.length > SUBAGENT_TITLE_MAX_CHARS
      ? `${source.slice(0, SUBAGENT_TITLE_MAX_CHARS - 1).trimEnd()}…`
      : source;
  return title.length > 0 ? title : "Sub-agent";
}

/**
 * A clear, unique branch name for a `workspace:"worktree"` child, e.g.
 * `subagent/4c796e3a-b64c`. Mirrors `makeAutomationBranchName`'s suffix
 * derivation in `automation/Layers/AutomationService.ts` (last 12
 * non-alphanumeric-sanitized, lowercased characters of the id) so worktree
 * branch names stay consistent across the codebase's programmatic spawners.
 */
function makeSubAgentBranchName(childThreadId: ThreadId): string {
  const suffix = childThreadId
    .replace(/[^a-z0-9]+/gi, "-")
    .slice(-12)
    .toLowerCase();
  return `subagent/${suffix}`;
}

const toDispatchError = (cause: OrchestrationDispatchError): SubAgentError =>
  new SubAgentError({
    reason: "dispatch-failed",
    detail: cause.message,
    cause,
  });

/** The child's `envMode`/`branch`/`worktreePath` triple for a `thread.create` dispatch. */
type SubAgentWorkspaceEnvironment = {
  readonly envMode: ThreadEnvironmentMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
};

/**
 * The terminal classifications `wait` tracks per child. Maps to the public
 * {@link SubAgentStatus} at build time (a still-running child has no entry and
 * becomes `"running"`).
 */
type SubAgentTerminalOutcome = "completed" | "failed" | "interrupted";

/**
 * Classify a child's session snapshot into a terminal outcome, or `null` when
 * the child is still in flight. `hasRun` gates the `idle`/`ready` → `completed`
 * transition: a freshly-created child sitting at its initial idle/starting
 * (before its turn has actually run) must NOT be mistaken for a finished turn.
 * Only once we have observed run-evidence (the session went `running`, or a
 * non-null `latestTurn`/an assistant message proves it already has — see the
 * seed loop in `wait`) does a return to idle with no active turn count as a
 * completed turn.
 */
function classifySession(
  session: OrchestrationSession | null,
  hasRun: boolean,
): SubAgentTerminalOutcome | null {
  if (session === null) {
    return null;
  }
  switch (session.status) {
    case "error":
      return "failed";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "idle":
    case "ready":
      return hasRun && session.activeTurnId === null ? "completed" : null;
    default:
      // "starting" | "running": a turn is pending or in flight, not terminal.
      return null;
  }
}

/** Text of the child's last assistant message, or `""` when it has none yet. */
function lastAssistantMessage(messages: readonly OrchestrationMessage[]): string {
  let latest: OrchestrationMessage | null = null;
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      (latest === null || message.createdAt >= latest.createdAt)
    ) {
      latest = message;
    }
  }
  return latest?.text ?? "";
}

/**
 * Fold a single domain event into the per-child resolution state. Only
 * `thread.session-set` carries terminal information — completion is driven
 * exclusively by the child's session reaching `idle`/`ready` with no active
 * turn AFTER it has actually run (see {@link classifySession}).
 *
 * `thread.turn-diff-completed` is deliberately NOT treated as terminal here.
 * ProviderRuntimeIngestion (`turn.diff.updated` handling, ~line 2518) dispatches
 * `thread.turn.diff.complete` with `status: "missing"` repeatedly DURING a
 * turn — it is a live placeholder checkpoint update, not a turn-finished
 * signal (CheckpointReactor reacts to the resulting domain event the same way,
 * ~line 972). Treating its mere arrival as "turn finished" would resolve a
 * still-running, file-editing child as `"completed"` with a partial
 * `finalMessage` — the core sub-agent use case this gate exists to protect.
 *
 * Events for non-target threads are ignored.
 */
function applyDomainEvent(
  event: OrchestrationEvent,
  targetIds: ReadonlySet<string>,
  applySession: (agentId: string, session: OrchestrationSession | null) => void,
): void {
  if (event.type === "thread.session-set" && targetIds.has(event.payload.threadId)) {
    applySession(event.payload.threadId, event.payload.session);
  }
}

/**
 * Project a child thread into a {@link SubAgentResult} envelope (§3.4). `diff`
 * is always `null` here — worktree diff population lands in Task 4.3. `error`
 * carries `session.lastError` and is only meaningful for a `"failed"` child.
 */
function buildSubAgentResult(
  agentId: ThreadId,
  thread: OrchestrationThread,
  outcome: SubAgentTerminalOutcome | null,
): SubAgentResult {
  const status: SubAgentStatus = outcome ?? "running";
  return {
    agentId,
    threadId: agentId,
    provider: thread.modelSelection.provider,
    model: thread.modelSelection.model ?? null,
    status,
    finalMessage: lastAssistantMessage(thread.messages),
    diff: null,
    error: thread.session?.lastError ?? null,
  };
}

export const SubAgentOrchestratorLive = Layer.effect(
  SubAgentOrchestrator,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const discovery = yield* ProviderDiscoveryService;
    const projection = yield* ProjectionSnapshotQuery;
    const git = yield* GitCore;

    // Read a child's projection detail, mapping an infra read failure to a typed
    // SubAgentError so `wait`'s only error channel stays SubAgentError.
    const readChildThread = (agentId: ThreadId) =>
      projection.getThreadDetailById(agentId).pipe(
        Effect.mapError(
          (cause) =>
            new SubAgentError({
              reason: "wait-failed",
              detail: `Failed to read sub-agent thread '${agentId}'.`,
              cause,
            }),
        ),
      );

    // Provision a REAL isolated Git worktree for a `workspace:"worktree"`
    // spawn (Task 4.1): resolve the parent PROJECT's repo root (not the
    // caller's own, possibly-already-isolated, workspace) via
    // ProjectionSnapshotQuery, then branch a new worktree off of that repo's
    // current HEAD (decision 10) -- or, when `includeWip` is requested
    // (Task 4.2), off of a dangling commit that snapshots the parent's
    // uncommitted changes onto that same HEAD (see `base` below). Any
    // failure here — the project can't be resolved, the WIP snapshot fails,
    // or `git worktree add` itself fails — surfaces as SubAgentError reason
    // "worktree-failed" and is thrown BEFORE `spawn` dispatches anything, so
    // a failed provisioning never leaves a half-created child thread behind.
    const resolveWorktreeWorkspace = (
      caller: SubAgentSpawnCaller,
      childThreadId: ThreadId,
      includeWip: boolean,
    ): Effect.Effect<SubAgentWorkspaceEnvironment, SubAgentError> =>
      Effect.gen(function* () {
        const projectOption = yield* projection.getProjectShellById(caller.projectId).pipe(
          Effect.mapError(
            (cause) =>
              new SubAgentError({
                reason: "worktree-failed",
                detail: `Failed to resolve the parent project '${caller.projectId}' for sub-agent worktree provisioning.`,
                cause,
              }),
          ),
        );
        if (Option.isNone(projectOption)) {
          return yield* Effect.fail(
            new SubAgentError({
              reason: "worktree-failed",
              detail: `Sub-agent worktree provisioning failed: parent project '${caller.projectId}' was not found.`,
            }),
          );
        }
        const project = projectOption.value;

        // `includeWip`: snapshot the parent's uncommitted changes (staged +
        // unstaged + untracked) into a dangling commit via
        // GitCore.snapshotWorkingTree -- entirely read-only w.r.t. the
        // parent's real working tree/index/stash -- and branch the worktree
        // from that commit instead of bare HEAD. A clean parent tree
        // (snapshot returns `null`) or `includeWip` not requested both fall
        // back to `"HEAD"`, i.e. Task 4.1's unchanged behavior.
        const base = includeWip
          ? ((yield* git.snapshotWorkingTree({ cwd: project.workspaceRoot }).pipe(
              Effect.mapError(
                (cause) =>
                  new SubAgentError({
                    reason: "worktree-failed",
                    detail: `Failed to snapshot the parent's uncommitted changes for the sub-agent worktree: ${cause.message}`,
                    cause,
                  }),
              ),
            ))?.commit ?? "HEAD")
          : "HEAD";

        const newBranch = makeSubAgentBranchName(childThreadId);
        const created = yield* git
          .createWorktree({
            cwd: project.workspaceRoot,
            branch: base,
            newBranch,
            path: null,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SubAgentError({
                  reason: "worktree-failed",
                  detail: `Failed to create an isolated Git worktree for the sub-agent: ${cause.message}`,
                  cause,
                }),
            ),
          );
        return {
          envMode: "worktree",
          branch: created.worktree.branch,
          worktreePath: created.worktree.path,
        };
      });

    const spawn: SubAgentOrchestratorShape["spawn"] = (caller, input) =>
      Effect.gen(function* () {
        // NOTE(Task 5.2): caller.canSpawn (depth-1) and concurrency limits are
        // intentionally not enforced here yet; they land in a later task.

        // 1. Validate the requested provider against the existing discovery
        // layer. An unregistered/unsupported provider fails discovery; surface
        // that as a structured, non-crashing SubAgentError.
        yield* discovery.getComposerCapabilities({ provider: input.provider }).pipe(
          Effect.mapError(
            (cause) =>
              new SubAgentError({
                reason: "provider-unavailable",
                detail: `Provider '${input.provider}' is not available.`,
                cause,
              }),
          ),
        );

        // 1b. Resolve the child's model. Fail fast (no dispatch) when the
        // caller gave no explicit model and the provider has no default
        // (e.g. `pi`) — never silently dispatch a thread.create with a null
        // model.
        const resolvedModel = resolveSubAgentModel(input.provider, input.model);
        if (resolvedModel === null) {
          return yield* Effect.fail(
            new SubAgentError({
              reason: "model-unavailable",
              detail: `No model available for provider '${input.provider}': no explicit model was given and the provider has no default model.`,
            }),
          );
        }

        // 2. Mint child identity + the two command ids (mirrors AutomationService).
        const childThreadId = ThreadId.makeUnsafe(randomUUID());
        const threadCreateCommandId = CommandId.makeUnsafe(randomUUID());
        const turnStartCommandId = CommandId.makeUnsafe(randomUUID());
        const messageId = MessageId.makeUnsafe(randomUUID());
        const now = new Date().toISOString();

        const modelSelection = buildModelSelection(input.provider, resolvedModel);
        const runtimeMode = runtimeModeForApproval(input.approval);
        const title = deriveSubAgentTitle(input);

        // 2b. Resolve the child's workspace. `"share"` copies the caller's
        // own workspace fields verbatim so resolveThreadWorkspaceCwd resolves
        // the child to the same cwd as the caller (decision 5, "share parent
        // cwd"). `"worktree"` (Task 4.1) provisions a real isolated worktree
        // BEFORE any command is dispatched, so a provisioning failure never
        // leaves a half-created child thread behind.
        const workspace: SubAgentWorkspaceEnvironment =
          input.workspace === "worktree"
            ? yield* resolveWorktreeWorkspace(caller, childThreadId, input.includeWip === true)
            : {
                envMode: caller.workspace.envMode,
                branch: caller.workspace.branch,
                worktreePath: caller.workspace.worktreePath,
              };

        // 3. Create the child thread, linked to the caller.
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: threadCreateCommandId,
            threadId: childThreadId,
            projectId: caller.projectId,
            title,
            modelSelection,
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            envMode: workspace.envMode,
            branch: workspace.branch,
            worktreePath: workspace.worktreePath,
            parentThreadId: caller.threadId,
            subagentAgentId: childThreadId,
            subagentRole: input.role ?? null,
            subagentNickname: input.nickname ?? null,
            createdAt: now,
          })
          .pipe(Effect.mapError(toDispatchError));

        // 4. Start the child's first turn carrying the delegated task.
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: turnStartCommandId,
            threadId: childThreadId,
            message: {
              messageId,
              role: "user",
              text: input.task,
              attachments: [],
            },
            modelSelection,
            dispatchMode: "queue",
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
          })
          .pipe(Effect.mapError(toDispatchError));

        return { agentId: childThreadId };
      });

    const wait: SubAgentOrchestratorShape["wait"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const timeoutSeconds = clampWaitSeconds(
            input.timeoutSeconds ?? SUBAGENT_WAIT_MAX_SECONDS,
          );
          const mode = input.mode ?? "all";
          const agentIds = input.agentIds;
          const targetIds = new Set<string>(agentIds);

          // Per-child resolution state. Effect fibers run cooperatively on one
          // thread and every apply below is synchronous (no await mid-mutation),
          // so plain mutable structures are race-free here.
          const outcomes = new Map<string, SubAgentTerminalOutcome>();
          const observedRunning = new Set<string>();

          // First terminal outcome wins and is stable (later events are ignored).
          const resolveOutcome = (agentId: string, outcome: SubAgentTerminalOutcome): void => {
            if (!outcomes.has(agentId)) {
              outcomes.set(agentId, outcome);
            }
          };
          const applySession = (agentId: string, session: OrchestrationSession | null): void => {
            if (session?.status === "running") {
              observedRunning.add(agentId);
            }
            const outcome = classifySession(session, observedRunning.has(agentId));
            if (outcome !== null) {
              resolveOutcome(agentId, outcome);
            }
          };
          const isResolved = (): boolean =>
            mode === "any"
              ? agentIds.some((agentId) => outcomes.has(agentId))
              : agentIds.every((agentId) => outcomes.has(agentId));

          const done = yield* Deferred.make<void>();
          const signalIfResolved = Effect.suspend(() =>
            isResolved() ? Deferred.succeed(done, undefined) : Effect.succeed(false),
          );

          // 1. Subscribe to the domain-event PubSub BEFORE snapshotting so a
          //    terminal event that fires in the seed gap is not lost.
          //    `engine.subscribeDomainEvents` is `PubSub.subscribe` under the
          //    hood (see `Layers/OrchestrationEngine.ts`), which registers
          //    the subscription synchronously the moment this effect is
          //    run — right here, before any `yield*` below can suspend this
          //    fiber on a SQL read. This is deliberately NOT
          //    `Stream.toPull(engine.streamDomainEvents)`: `streamDomainEvents`
          //    is `Stream.fromPubSub`, and `Stream.toPull` on it defers the
          //    actual `PubSub.subscribe` call inside an `Effect.suspend` that
          //    only fires on the FIRST pull (see `effect`'s `Channel.unwrap`)
          //    — which would happen inside the drain fiber forked in step 3,
          //    AFTER the seed loop, so any event published during the seed
          //    loop's SQL reads would be silently dropped. Subscribing here
          //    instead means nothing published from this point on can be
          //    missed: the subscription (not our later consumption of it) is
          //    what determines what gets buffered.
          //
          //    Consumption is intentionally NOT started yet (step 3, after the
          //    seed loop) even though the subscription itself is already
          //    live: an event applied before the seed loop has populated
          //    `observedRunning` for an already-running child would see
          //    `hasRun === false` and wrongly fail to resolve it. Draining
          //    after the seed loop guarantees every buffered event is applied
          //    against a fully-seeded `observedRunning`/`outcomes` state.
          const domainEventSubscription = yield* engine.subscribeDomainEvents;

          // 2. Seed each child's current state. A child may already be terminal
          //    at seed time — resolve it immediately rather than hang.
          for (const agentId of agentIds) {
            const threadOption = yield* readChildThread(agentId);
            if (Option.isNone(threadOption)) {
              return yield* Effect.fail(
                new SubAgentError({
                  reason: "unknown-agent",
                  detail: `No sub-agent thread found for agentId '${agentId}'.`,
                }),
              );
            }
            const thread = threadOption.value;
            // Seed run-evidence, gating the idle/ready -> completed transition
            // below: latestTurn starts null at thread.create (projector.ts's
            // "thread.created" case) and is populated only as a byproduct of
            // turn/checkpoint activity — not just a "running" thread.session-set,
            // but also thread.turn-diff-completed, thread.reverted, and
            // thread.conversation-rolled-back (see projector.ts) — none of
            // which fire before the child's first turn has actually run. So a
            // non-null latestTurn still proves the session has run at least
            // once; an assistant message is an independent signal for the
            // same fact (the provider has produced output). Either is
            // sufficient. A bare seed idle/starting with NEITHER — a
            // freshly-spawned, not-yet-run child — has no run evidence and
            // must NOT be mistaken for a finished turn.
            const hasAssistantMessage = thread.messages.some(
              (message) => message.role === "assistant",
            );
            if (thread.latestTurn !== null || hasAssistantMessage) {
              observedRunning.add(agentId);
            }
            applySession(agentId, thread.session);
            if (!outcomes.has(agentId) && thread.latestTurn?.state === "completed") {
              resolveOutcome(agentId, "completed");
            }
          }
          yield* signalIfResolved;

          // 3. NOW drain the already-subscribed event stream in the
          //    background: any events buffered since step 1 (including one
          //    that raced the seed loop) are applied first, in order, followed
          //    by any future events. `{ startImmediately: true }` starts this
          //    fiber synchronously (no scheduler round-trip) since the seed
          //    loop has already run, so it is always safe here. The loop needs
          //    no explicit exit condition: `Effect.scoped` (wrapping this
          //    whole generator) interrupts this forked fiber — and tears down
          //    the subscription acquired in step 1 — the moment `wait`
          //    returns, whether via resolution or timeout.
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (true) {
                const event = yield* PubSub.take(domainEventSubscription);
                applyDomainEvent(event, targetIds, applySession);
                yield* signalIfResolved;
              }
            }),
            { startImmediately: true },
          );

          // 4. Block until the resolution predicate holds or the timeout elapses.
          //    On timeout, still-unresolved children fall through to "running".
          yield* Deferred.await(done).pipe(Effect.timeoutOption(Duration.seconds(timeoutSeconds)));

          // 5. Build one envelope per agentId, in input order, from a fresh read.
          const results: SubAgentResult[] = [];
          for (const agentId of agentIds) {
            const threadOption = yield* readChildThread(agentId);
            if (Option.isNone(threadOption)) {
              return yield* Effect.fail(
                new SubAgentError({
                  reason: "unknown-agent",
                  detail: `No sub-agent thread found for agentId '${agentId}'.`,
                }),
              );
            }
            results.push(
              buildSubAgentResult(agentId, threadOption.value, outcomes.get(agentId) ?? null),
            );
          }
          return results;
        }),
      );

    return { spawn, wait } satisfies SubAgentOrchestratorShape;
  }),
);
