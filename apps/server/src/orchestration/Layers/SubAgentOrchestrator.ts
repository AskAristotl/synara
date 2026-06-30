/**
 * SubAgentOrchestratorLive - Layer implementation of {@link SubAgentOrchestrator}.
 *
 * Phase 1 implements the share-cwd `spawn` path only: validate the provider via
 * discovery, mint a child thread, and dispatch `thread.create` +
 * `thread.turn.start` through {@link OrchestrationEngineService}. The command
 * construction mirrors `automation/Layers/AutomationService.ts` (the same
 * server-side "create a thread and start its first turn" flow).
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
 * is a discriminated union keyed on `provider`; TypeScript cannot construct the
 * matching member from a runtime `ProviderKind`, so we assemble the minimal
 * `{ provider, model }` shape and assert — the same idiom used in
 * `apps/server/src/serverSettings.ts`. The model falls back to the provider
 * default when the caller did not specify one.
 */
function buildModelSelection(provider: ProviderKind, model: string | undefined): ModelSelection {
  return { provider, model: model ?? getDefaultModel(provider) } as ModelSelection;
}

/**
 * Map a spawn's `approval` knob to a thread `runtimeMode`.
 *
 * TODO(Task 5.1): real approval resolution. `auto` and `read-only` both run
 * `full-access` for now (no sandboxed read-only runtime yet); `ask-human` uses
 * `approval-required` so requests surface instead of being auto-resolved.
 */
function runtimeModeForApproval(approval: SubAgentApprovalMode): RuntimeMode {
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

        // 2. Mint child identity + the two command ids (mirrors AutomationService).
        const childThreadId = ThreadId.makeUnsafe(randomUUID());
        const threadCreateCommandId = CommandId.makeUnsafe(randomUUID());
        const turnStartCommandId = CommandId.makeUnsafe(randomUUID());
        const messageId = MessageId.makeUnsafe(randomUUID());
        const now = new Date().toISOString();

        const modelSelection = buildModelSelection(input.provider, input.model);
        const runtimeMode = runtimeModeForApproval(input.approval);
        const title = deriveSubAgentTitle(input);

        // 3. Create the child thread, linked to the caller. Share-cwd path:
        // envMode "local", no worktree.
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
            envMode: "local",
            branch: null,
            worktreePath: null,
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
