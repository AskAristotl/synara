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
 * `sendMessage` and `stopAgent` (Task 6.1) are the ownership-checked v1
 * multi-turn/lifecycle tools: both run `assertOwnership` FIRST -- the target
 * `agentId` must be a thread whose `parentThreadId` is the calling session's
 * own `threadId`, or the call fails with `SubAgentError` reason `"not-owner"`
 * before any dispatch. `sendMessage` then dispatches a `thread.turn.start`
 * for the child mirroring `spawn`'s own first-turn dispatch; `stopAgent`
 * delegates to the caller-agnostic `stop` (used directly, without an
 * ownership check, by `cascadeStopChildren`).
 *
 * @module SubAgentOrchestratorLive
 */
import { randomUUID } from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ModelSelection,
  type OrchestrationCheckpointFile,
  type OrchestrationCheckpointSummary,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProviderKind,
  type RuntimeMode,
  type SubAgentApprovalMode,
  type SubAgentResult,
  type SubAgentResultDiff,
  type SubAgentSpawnInput,
  type SubAgentStatus,
  type ThreadEnvironmentMode,
  ThreadId,
} from "@t3tools/contracts";
import { Deferred, Duration, Effect, Layer, Option, PubSub } from "effect";

import { getDefaultModel } from "@t3tools/shared/model";
import {
  clampWaitSeconds,
  SUBAGENT_DIFF_SETTLE_SECONDS,
  SUBAGENT_MAX_LIVE_PER_ROOT,
  SUBAGENT_WAIT_MAX_SECONDS,
} from "@t3tools/shared/subagent";

import type { OrchestrationDispatchError } from "../Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  type SubAgentCaller,
  SubAgentError,
  SubAgentOrchestrator,
  type SubAgentOrchestratorShape,
  type SubAgentSpawnCaller,
} from "../Services/SubAgentOrchestrator.ts";

const SUBAGENT_TITLE_MAX_CHARS = 80;

/**
 * Poll interval (ms) `wait`'s settle phase (Task 4.3b) re-reads a worktree
 * child's projection while waiting for its file-bearing checkpoint to land.
 * Small relative to `SUBAGENT_DIFF_SETTLE_SECONDS`'s default 5s grace
 * window -- prompt without being a busy loop (at most ~100 reads over the
 * default window), and it only ever runs for the handful of worktree
 * children that are already "completed" but still checkpoint-less at settle
 * time.
 */
const SUBAGENT_DIFF_SETTLE_POLL_MILLIS = 50;

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
 * Map a spawn's `approval` knob to a thread `runtimeMode` (Task 5.1).
 *
 * `auto` runs `full-access` -- the provider auto-allows, so approval requests
 * rarely fire; {@link SubAgentApprovalResolverLive} auto-accepts any that do.
 * `read-only` and `ask-human` both run `approval-required` so writes/exec
 * actually produce approval requests (providers do not prompt for plain
 * reads under `approval-required` -- they proceed without a request, which
 * is what makes `read-only` effectively read-only): the resolver
 * auto-declines every request for `read-only`, and leaves every request for
 * a human to answer for `ask-human`. `read-only` mapping to `approval-required`
 * is a CHANGE from Phase 1, which mapped it to `full-access` pending this
 * resolver.
 *
 * Accepts `undefined` because `SubAgentSpawnInput.approval`'s static `.Type`
 * still carries `| undefined` from `Schema.optional` even though
 * `Schema.withDecodingDefault` guarantees a runtime value (`"auto"`) — treat
 * `undefined` the same as `"auto"`.
 */
function runtimeModeForApproval(approval: SubAgentApprovalMode | undefined): RuntimeMode {
  return approval === "auto" || approval === undefined ? "full-access" : "approval-required";
}

/**
 * Session statuses under which a child thread's runtime is still active, for
 * the per-root concurrency cap (Task 5.2, decision 12). This is every
 * {@link OrchestrationSessionStatus} EXCEPT the three terminal ones --
 * `"stopped"` | `"error"` | `"interrupted"`: a child that hasn't started
 * running yet (`"idle"` | `"starting"`) or is actively running
 * (`"running"` | `"ready"`) still occupies a slot. A terminal child has
 * stopped consuming a runtime slot and is FREED from the cap the instant its
 * session reaches one of those three statuses, regardless of how long ago
 * that happened.
 */
const LIVE_CHILD_SESSION_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "idle",
  "starting",
  "running",
  "ready",
]);

/**
 * Whether a child thread's session still counts toward its caller's live-child
 * concurrency cap (Task 5.2). A `null` session (no runtime has ever attached
 * -- should not normally occur for a dispatched child, but treated the same
 * as terminal defensively) or a terminal status does NOT count: only
 * {@link LIVE_CHILD_SESSION_STATUSES} counts as live.
 */
function isLiveChildSession(session: OrchestrationSession | null): boolean {
  return session !== null && LIVE_CHILD_SESSION_STATUSES.has(session.status);
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
 * A concise, deterministic one-line stat for a checkpoint's files, e.g.
 * `"2 files changed, +6/-2"` (singular `"1 file changed, ..."`). Additions and
 * deletions are summed across every file in the checkpoint.
 */
function summarizeCheckpointFiles(files: readonly OrchestrationCheckpointFile[]): string {
  const totals = files.reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const fileWord = files.length === 1 ? "file" : "files";
  return `${files.length} ${fileWord} changed, +${totals.additions}/-${totals.deletions}`;
}

/**
 * The freshest checkpoint that actually has files, or `null` when the child
 * has produced no file-bearing checkpoint yet. `thread.checkpoints` is kept
 * sorted ascending by `checkpointTurnCount` both by the projector's in-memory
 * fold (`projector.ts`, the `thread.turn-diff-completed` case) and by the SQL
 * projection read (`ProjectionSnapshotQuery.ts`'s `listCheckpointRowsByThread`,
 * `ORDER BY checkpoint_turn_count ASC`) — so the array's last entry is already
 * the most recent by construction. This still selects by MAX
 * `checkpointTurnCount` explicitly rather than trusting array order, so the
 * choice stays correct (and self-documenting) even if that upstream ordering
 * invariant ever changes.
 */
function latestCheckpointWithFiles(
  checkpoints: readonly OrchestrationCheckpointSummary[],
): OrchestrationCheckpointSummary | null {
  let latest: OrchestrationCheckpointSummary | null = null;
  for (const checkpoint of checkpoints) {
    if (checkpoint.files.length === 0) {
      continue;
    }
    if (latest === null || checkpoint.checkpointTurnCount > latest.checkpointTurnCount) {
      latest = checkpoint;
    }
  }
  return latest;
}

/**
 * Build the `diff` field of a {@link SubAgentResult} envelope (§3.4). Only an
 * isolated writer -- `envMode:"worktree"` with a resolved `branch` and at
 * least one file-bearing checkpoint -- gets a non-null diff; a share-cwd
 * child (`envMode:"local"`) always gets `null` regardless of checkpoints,
 * since there is no dedicated branch to integrate its changes from. A
 * worktree child with no branch (should not normally happen -- `branch` is
 * set at provisioning time, Task 4.1) also falls back to `null`: a diff with
 * no branch to point callers at is useless.
 */
function buildSubAgentDiff(thread: OrchestrationThread): SubAgentResultDiff | null {
  if (thread.envMode !== "worktree" || thread.branch === null) {
    return null;
  }
  const checkpoint = latestCheckpointWithFiles(thread.checkpoints);
  if (checkpoint === null) {
    return null;
  }
  return {
    branch: thread.branch,
    filesChanged: checkpoint.files.length,
    summary: summarizeCheckpointFiles(checkpoint.files),
  };
}

/**
 * Project a child thread into a {@link SubAgentResult} envelope (§3.4). `diff`
 * is populated only for an isolated writer that has produced a file-bearing
 * checkpoint (see {@link buildSubAgentDiff}). `error` carries
 * `session.lastError` and is only meaningful for a `"failed"` child.
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
    diff: buildSubAgentDiff(thread),
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

    // Task 6.1: shared ownership check for `sendMessage`/`stopAgent`. Resolves
    // the target `agentId`'s shell row -- `parentThreadId` is all
    // `assertOwnership` needs, so this uses the same lightweight
    // `getThreadShellById` read `spawn`'s per-root concurrency cap (Task 5.2)
    // and `cascadeStopChildren` (Task 5.3) already lean on for shell-level
    // reads, rather than hydrating a full thread detail. Fails with
    // `SubAgentError` reason `"not-owner"` unless the target thread EXISTS
    // AND its `parentThreadId` is exactly `caller.threadId` -- both callers
    // run this FIRST, before any dispatch, so a rejected call has zero side
    // effects. An infra failure resolving the target also surfaces as
    // `"not-owner"` rather than a separate reason: ownership cannot be
    // confirmed, so the operation cannot proceed on the caller's behalf
    // (the same fail-closed philosophy `spawn`'s concurrency-cap read uses).
    const assertOwnership = (
      caller: SubAgentCaller,
      agentId: ThreadId,
    ): Effect.Effect<void, SubAgentError> =>
      projection.getThreadShellById(agentId).pipe(
        Effect.mapError(
          (cause) =>
            new SubAgentError({
              reason: "not-owner",
              detail: `Failed to resolve sub-agent '${agentId}' while checking ownership.`,
              cause,
            }),
        ),
        Effect.flatMap((threadOption) =>
          Option.isSome(threadOption) && threadOption.value.parentThreadId === caller.threadId
            ? Effect.void
            : Effect.fail(
                new SubAgentError({
                  reason: "not-owner",
                  detail: `Sub-agent '${agentId}' is not a child of the calling session '${caller.threadId}'.`,
                }),
              ),
        ),
      );

    // Task 4.3b: `wait` resolves a worktree child's outcome to "completed" the
    // moment its session goes idle (`thread.session-set`), but the
    // authoritative file-bearing checkpoint (`thread.turn-diff-completed`,
    // status "ready") is produced by CheckpointReactor -- an INDEPENDENT,
    // concurrently-forked consumer of the same domain-event stream that does
    // real git I/O -- which usually lands AFTER that session-set. Read
    // straight off `buildSubAgentResult`'s final envelope build at that
    // instant would therefore usually see `diff: null` for the mainline
    // "spawn -> edit -> report" worktree pattern, even though the child truly
    // did produce a checkpoint moments later.
    //
    // `settleForFileBearingCheckpoint` closes that gap: for a worktree child
    // (envMode "worktree", non-null branch) whose outcome is ALREADY
    // "completed" (this is only ever called from `wait`'s step 5, after the
    // session-idle transition has already been classified -- it never marks a
    // still-running child completed and never touches `outcomes`/
    // `isResolved`/mode "all"/"any" semantics), poll `readChildThread` on a
    // short interval (`SUBAGENT_DIFF_SETTLE_POLL_MILLIS`) until EITHER a
    // file-bearing checkpoint appears (`latestCheckpointWithFiles` non-null)
    // or `waitDeadlineMillis` is reached, whichever comes first.
    // `waitDeadlineMillis` is the SAME absolute deadline `wait`'s own overall
    // clamped timeout is bounded by (computed once, at the top of `wait`), so
    // this can only ever consume time budget already available within the
    // caller's requested `timeoutSeconds` -- it never extends `wait`'s total
    // bound. The grace window this settle actually gets is additionally
    // capped by `SUBAGENT_DIFF_SETTLE_SECONDS` (evaluated fresh, from "now",
    // each time this is called) so a single very-long `timeoutSeconds` still
    // only buys a short, bounded settle rather than the whole remaining
    // budget. The background domain-event drain fiber `wait` forked in step 3
    // is still alive throughout (this runs inside the same `Effect.scoped`
    // block, before that scope closes) -- no new subscription is created
    // here.
    const settleForFileBearingCheckpoint = (
      agentId: ThreadId,
      thread: OrchestrationThread,
      outcome: SubAgentTerminalOutcome | null,
      waitDeadlineMillis: number,
    ): Effect.Effect<OrchestrationThread, SubAgentError> => {
      const eligible =
        outcome === "completed" && thread.envMode === "worktree" && thread.branch !== null;
      if (!eligible || latestCheckpointWithFiles(thread.checkpoints) !== null) {
        return Effect.succeed(thread);
      }
      const settleDeadlineMillis = Math.min(
        waitDeadlineMillis,
        Date.now() + SUBAGENT_DIFF_SETTLE_SECONDS * 1000,
      );
      return Effect.gen(function* () {
        let current = thread;
        while (
          latestCheckpointWithFiles(current.checkpoints) === null &&
          Date.now() < settleDeadlineMillis
        ) {
          const remainingMillis = settleDeadlineMillis - Date.now();
          yield* Effect.sleep(
            Duration.millis(Math.min(SUBAGENT_DIFF_SETTLE_POLL_MILLIS, remainingMillis)),
          );
          const threadOption = yield* readChildThread(agentId);
          if (Option.isSome(threadOption)) {
            current = threadOption.value;
          }
        }
        return current;
      });
    };

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
        // Task 5.2, check 1 (depth-1) -- FIRST, cheap, no I/O. Defense-in-depth:
        // the MCP layer (subagentMcp/SubAgentMcpServer.ts) already refuses to
        // expose the spawn tool to a sub-agent thread, but the orchestrator
        // enforces depth-1 itself too, so no other caller of `spawn` (tests,
        // future transports) can bypass it. Checked before ANY I/O so a
        // rejected spawn has zero side effects -- no worktree provisioning, no
        // provider-discovery call, no dispatch.
        if (!caller.canSpawn) {
          return yield* Effect.fail(
            new SubAgentError({
              reason: "depth-limit",
              detail: "Sub-agents cannot spawn further sub-agents (depth-1 governance limit).",
            }),
          );
        }

        // Task 5.2, check 2 (per-root concurrency cap) -- count the caller's
        // LIVE children and reject before any worktree provisioning or
        // dispatch if spawning one more would exceed
        // SUBAGENT_MAX_LIVE_PER_ROOT. A "child" is a thread whose
        // `parentThreadId === caller.threadId`; a child is "LIVE" when it
        // still has an active runtime -- see `isLiveChildSession` above for
        // the exact predicate (non-null session, non-terminal status). A
        // child with no session, or a terminal session
        // (`"stopped"`/`"error"`/`"interrupted"`), has already freed its slot
        // and does NOT count -- so 5 live children lets the 6th spawn
        // succeed, but 6 live children rejects the 7th. Counted off
        // `ProjectionSnapshotQuery.getShellSnapshot` -- the lightest
        // projection read whose thread rows carry both `parentThreadId` and
        // `session.status` (`OrchestrationThreadShell`), avoiding a full
        // detail hydration (messages/checkpoints/etc.) per candidate child.
        const shellSnapshot = yield* projection.getShellSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new SubAgentError({
                reason: "concurrency-limit",
                detail: "Failed to read the caller's live sub-agent count for the concurrency cap.",
                cause,
              }),
          ),
        );
        const liveChildCount = shellSnapshot.threads.filter(
          (thread) =>
            thread.parentThreadId === caller.threadId && isLiveChildSession(thread.session),
        ).length;
        if (liveChildCount >= SUBAGENT_MAX_LIVE_PER_ROOT) {
          return yield* Effect.fail(
            new SubAgentError({
              reason: "concurrency-limit",
              detail: `Caller already has ${liveChildCount} live sub-agent(s), at the per-root cap of ${SUBAGENT_MAX_LIVE_PER_ROOT}.`,
            }),
          );
        }

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
            subagentApproval: input.approval ?? "auto",
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

    // Task 6.3: `wait` is ownership-checked, mirroring `sendMessage`/
    // `stopAgent` (Task 6.1). Every requested `agentId` must be a thread
    // whose `parentThreadId === caller.threadId` (`assertOwnership` above),
    // checked ONE AT A TIME, in `input.agentIds` order, as the very FIRST
    // step -- strictly before the domain-event subscription and seed reads
    // in the scoped block below. The first non-owned (or nonexistent)
    // `agentId` fails the whole call with `SubAgentError` reason
    // `"not-owner"` and short-circuits the rest of the loop (a `for` loop
    // yielding a failing effect aborts the generator immediately), so a
    // rejected `wait` call never subscribes to the domain-event stream and
    // never reads any child's projection -- zero side effects, exactly like
    // a rejected `sendMessage`/`stopAgent`.
    const wait: SubAgentOrchestratorShape["wait"] = (caller, input) =>
      Effect.gen(function* () {
        for (const agentId of input.agentIds) {
          yield* assertOwnership(caller, agentId);
        }

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const timeoutSeconds = clampWaitSeconds(
              input.timeoutSeconds ?? SUBAGENT_WAIT_MAX_SECONDS,
            );
            // The single absolute deadline this whole `wait` call is bounded
            // by -- both step 4's overall resolution wait AND (Task 4.3b) each
            // worktree child's post-completion checkpoint settle are clamped
            // against this SAME instant, so settling never extends `wait`'s
            // total bound past the caller's (clamped) `timeoutSeconds`.
            const waitDeadlineMillis = Date.now() + timeoutSeconds * 1000;
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
            yield* Deferred.await(done).pipe(
              Effect.timeoutOption(Duration.seconds(timeoutSeconds)),
            );

            // 5. Build one envelope per agentId, in input order, from a fresh read.
            //    (Task 4.3b) A worktree child that just resolved "completed"
            //    gets one extra step here: settleForFileBearingCheckpoint
            //    briefly polls for its file-bearing checkpoint (bounded by
            //    waitDeadlineMillis) before the envelope is built, so `diff`
            //    isn't usually null for the mainline worktree pattern. Every
            //    other child (share/local, failed, interrupted, still running)
            //    is a same-tick no-op passthrough -- no behavior change.
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
              const outcome = outcomes.get(agentId) ?? null;
              const thread = yield* settleForFileBearingCheckpoint(
                agentId,
                threadOption.value,
                outcome,
                waitDeadlineMillis,
              );
              results.push(buildSubAgentResult(agentId, thread, outcome));
            }
            return results;
          }),
        );
      });

    // Task 6.1: start a follow-up turn on a child the caller already spawned.
    // Ownership is checked FIRST (`assertOwnership` above) -- a rejected call
    // dispatches nothing. Once confirmed, re-reads the child's shell row to
    // get its `modelSelection`/`runtimeMode`/`interactionMode`:
    // `assertOwnership` only returns `void` per its own contract, so this is
    // a deliberate second (cheap, shell-level) read rather than threading the
    // already-fetched thread back out of it. Dispatches `thread.turn.start`
    // for `input.agentId` -- the SAME command shape `spawn` uses for a
    // child's FIRST turn (fresh `CommandId`/`MessageId`,
    // `dispatchMode: "queue"`, the child's own model/runtime/interaction
    // mode), so a follow-up turn is indistinguishable from any other turn on
    // the child's own timeline. `dispatchMode: "queue"` means a child that is
    // still mid-turn queues this follow-up rather than rejecting it -- the
    // caller does not need to `wait` for the child to go idle first.
    const sendMessage: SubAgentOrchestratorShape["sendMessage"] = (caller, input) =>
      Effect.gen(function* () {
        yield* assertOwnership(caller, input.agentId);

        const childOption = yield* projection.getThreadShellById(input.agentId).pipe(
          Effect.mapError(
            (cause) =>
              new SubAgentError({
                reason: "not-owner",
                detail: `Failed to re-read sub-agent '${input.agentId}' after confirming ownership.`,
                cause,
              }),
          ),
        );
        if (Option.isNone(childOption)) {
          return yield* Effect.fail(
            new SubAgentError({
              reason: "not-owner",
              detail: `Sub-agent '${input.agentId}' disappeared after ownership was confirmed.`,
            }),
          );
        }
        const child = childOption.value;

        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(randomUUID()),
            threadId: input.agentId,
            message: {
              messageId: MessageId.makeUnsafe(randomUUID()),
              role: "user",
              text: input.task,
              attachments: [],
            },
            modelSelection: child.modelSelection,
            dispatchMode: "queue",
            runtimeMode: child.runtimeMode,
            interactionMode: child.interactionMode,
            createdAt: new Date().toISOString(),
          })
          .pipe(Effect.mapError(toDispatchError));
      });

    // Task 5.3: stop one child's session. Dispatches ONLY
    // `ThreadSessionStopCommand` for `agentId` -- deliberately NOT a separate
    // `ThreadTurnInterruptCommand` first, even though the child may have an
    // active turn. Traced end to end before deciding this (see the task
    // report for the full trace):
    //
    // - `thread.session.stop` -> `decider.ts`'s `"thread.session.stop"` case
    //   -> `thread.session-stop-requested` -> `ProviderCommandReactor.ts`'s
    //   `processSessionStopRequested` -- which UNCONDITIONALLY drives the
    //   child's own `thread.session` to a terminal `"stopped"` status
    //   (`setThreadSession`) regardless of what happens with the underlying
    //   provider process. So a bare session-stop dispatch is always
    //   sufficient to make the child stop counting as "live" for
    //   `isLiveChildSession` / the per-root concurrency cap (Task 5.2) and
    //   for `cascadeStopChildren`'s own live-child enumeration below.
    // - Dispatching a SEPARATE `ThreadTurnInterruptCommand` for the child
    //   would route through `processTurnInterruptRequested`, which resolves
    //   the "owning" provider-session thread via `resolveProviderSessionThread`.
    //   That helper predates this cross-model sub-agent feature: it was
    //   built for a DIFFERENT, provider-NATIVE "sub-agent" concept (a
    //   provider's own in-process collaborator/tool-call conversation,
    //   represented as a synthetic thread id `subagent:<parentId>:<childId>`,
    //   see `ProviderRuntimeIngestion.ts`'s `subagentThreadId`) that
    //   genuinely DOES share its parent's real provider session/process.
    //   `resolveProviderSessionThread` treats ANY thread with a non-null
    //   `parentThreadId` as belonging to that shared-session case -- it does
    //   NOT check for the `subagent:` id prefix before redirecting to the
    //   parent. A cross-model child minted by `spawn` above has
    //   `parentThreadId` set (to the caller) but a PLAIN `ThreadId`
    //   (`randomUUID()`, no prefix) and a REAL, independent provider session
    //   of its own (`processTurnStartRequested` starts it directly against
    //   `event.payload.threadId`, never through `resolveProviderSessionThread`).
    //   So for a cross-model child, `resolveProviderSessionThread` WRONGLY
    //   resolves to the child's PARENT thread, and a separate interrupt would
    //   call `providerService.interruptTurn` against the PARENT's own live
    //   session/turn -- exactly the opposite of "stop the child, leave the
    //   parent alone." Empirically verified against a real
    //   `ProviderCommandReactor` harness: dispatching only
    //   `thread.session.stop` for a plain-UUID child calls neither
    //   `interruptTurn` nor `stopSession` (the projection still lands on
    //   `"stopped"` regardless), while a separate interrupt would misfire at
    //   the parent -- true of `resolveProviderSessionThread` AT THE TIME this
    //   was written (Task 5.3). Given that, the minimal AND safe choice was a
    //   bare session-stop.
    //
    // RESOLVED (was tracked as a follow-up here, now fixed by Task 5.3b):
    // `ProviderCommandReactor.ts`'s `resolveProviderSessionThread` now checks
    // the `subagent:` id prefix (via `resolveSubagentProviderThreadId`)
    // before treating a non-null `parentThreadId` as the shared-session case,
    // so it correctly resolves a cross-model child (plain, non-prefixed
    // `ThreadId`) to ITSELF rather than to its parent. `processSessionStopRequested`
    // therefore now finds `ownsProviderSession === true` for a cross-model
    // child and calls `providerService.stopSession` against the CHILD's own
    // provider session -- the child's underlying provider process IS
    // reliably torn down by this bare `thread.session.stop`, not just its
    // orchestration-level session status.
    const stop: SubAgentOrchestratorShape["stop"] = (agentId) =>
      engine
        .dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe(randomUUID()),
          threadId: agentId,
          createdAt: new Date().toISOString(),
        })
        .pipe(Effect.asVoid, Effect.mapError(toDispatchError));

    // Task 6.1: stop a child the caller already spawned. Ownership is checked
    // FIRST (`assertOwnership` above) -- a rejected call stops nothing. Once
    // confirmed, delegates to the caller-agnostic `stop` above, which is the
    // single place that knows how a session-stop dispatch behaves (see its
    // own doc comment for the full "why not also interrupt" rationale).
    const stopAgent: SubAgentOrchestratorShape["stopAgent"] = (caller, input) =>
      Effect.gen(function* () {
        yield* assertOwnership(caller, input.agentId);
        yield* stop(input.agentId);
      });

    // Task 5.3: cascade-stop every LIVE child of `parentThreadId`. Reuses the
    // exact same "live child" read/predicate as `spawn`'s per-root
    // concurrency cap (Task 5.2) -- `ProjectionSnapshotQuery.getShellSnapshot`
    // filtered by `parentThreadId` match + `isLiveChildSession` -- so an
    // already-terminal child (stopped/error/interrupted, or no session at
    // all) is skipped, not re-stopped. This is what makes the recursive call
    // this triggers for each freshly-stopped child (via
    // `SubAgentCascadeStopReactor` reacting to that child's own
    // `thread.session-stop-requested`) safely terminate: depth-1 governance
    // (Task 5.2) means a child has no children of its own, so its own
    // `cascadeStopChildren` call reads an empty live-child list and is a
    // no-op immediately. Even without depth-1, this can never cycle back to
    // an ancestor -- `parentThreadId` is fixed at `thread.create` time and
    // thread ids are unique, so the parent-of/child-of relation is a DAG,
    // not a graph with cycles.
    const cascadeStopChildren: SubAgentOrchestratorShape["cascadeStopChildren"] = (
      parentThreadId,
    ) =>
      Effect.gen(function* () {
        const shellSnapshot = yield* projection.getShellSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new SubAgentError({
                reason: "stop-failed",
                detail: `Failed to read live sub-agent children for cascade-stop of parent '${parentThreadId}'.`,
                cause,
              }),
          ),
        );
        const liveChildIds = shellSnapshot.threads
          .filter(
            (thread) =>
              thread.parentThreadId === parentThreadId && isLiveChildSession(thread.session),
          )
          .map((thread) => thread.id);
        yield* Effect.forEach(liveChildIds, stop, { discard: true });
      });

    return {
      spawn,
      wait,
      sendMessage,
      stopAgent,
      stop,
      cascadeStopChildren,
    } satisfies SubAgentOrchestratorShape;
  }),
);
