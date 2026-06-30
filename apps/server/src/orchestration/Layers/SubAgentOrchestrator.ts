/**
 * SubAgentOrchestratorLive - Layer implementation of {@link SubAgentOrchestrator}.
 *
 * Phase 1 implements the share-cwd `spawn` path only: validate the provider via
 * discovery, resolve a model, mint a child thread, and dispatch `thread.create`
 * + `thread.turn.start` through {@link OrchestrationEngineService}. The command
 * construction mirrors `automation/Layers/AutomationService.ts` (the same
 * server-side "create a thread and start its first turn" flow).
 *
 * The child's workspace (`envMode`/`worktreePath`/`branch`) is copied verbatim
 * from `caller.workspace` so `resolveThreadWorkspaceCwd`
 * (`@t3tools/shared/threadEnvironment`) resolves the child to the same cwd as
 * the caller (decision 5, "share parent cwd" —
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md §3.3/§5).
 * `workspace:"worktree"` provisioning (a real isolated worktree) is
 * Task 4.1; until then it falls back to the same copy-caller-workspace
 * behavior as `"share"`.
 *
 * @module SubAgentOrchestratorLive
 */
import { randomUUID } from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ModelSelection,
  type ProviderKind,
  type RuntimeMode,
  type SubAgentApprovalMode,
  type SubAgentSpawnInput,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { getDefaultModel } from "@t3tools/shared/model";

import type { OrchestrationDispatchError } from "../Errors.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  SubAgentError,
  SubAgentOrchestrator,
  type SubAgentOrchestratorShape,
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

const toDispatchError = (cause: OrchestrationDispatchError): SubAgentError =>
  new SubAgentError({
    reason: "dispatch-failed",
    detail: cause.message,
    cause,
  });

export const SubAgentOrchestratorLive = Layer.effect(
  SubAgentOrchestrator,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const discovery = yield* ProviderDiscoveryService;

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

        // 3. Create the child thread, linked to the caller. Both `"share"`
        // and (for now, pending Task 4.1) `"worktree"` copy the caller's own
        // workspace fields verbatim so resolveThreadWorkspaceCwd resolves the
        // child to the same cwd as the caller (decision 5, "share parent
        // cwd").
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
            envMode: caller.workspace.envMode,
            branch: caller.workspace.branch,
            worktreePath: caller.workspace.worktreePath,
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

    return { spawn } satisfies SubAgentOrchestratorShape;
  }),
);
