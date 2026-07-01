// FILE: diagramCapability.ts
// Purpose: Single source-of-truth instruction telling a provider's model it can draft
//          renderable Mermaid diagrams, plus the rule for which providers get it via a
//          first-turn prompt preamble (those without a dedicated system-prompt channel).
// Layer: Server provider helper
// Exports: MERMAID_CAPABILITY_INSTRUCTION, diagramCapabilityPreambleFor

import type { ProviderKind } from "@t3tools/contracts";

export const MERMAID_CAPABILITY_INSTRUCTION =
  "When a diagram would make your answer clearer (architecture, control/data flow, " +
  "sequences, state machines), output it as a fenced ```mermaid code block. Synara " +
  "renders it inline for the user. Use diagrams judiciously — only when they add real " +
  "clarity, not for trivial points.";

// Providers that expose a dedicated system/developer instruction channel get the
// capability advertised there (see codexAppServerManager.ts and ClaudeAdapter.ts),
// so they must NOT also receive the prompt preamble. Every other provider (cursor,
// gemini, grok, kilo, opencode, pi) has no such channel and gets a first-turn preamble.
const PROVIDERS_WITH_SYSTEM_INSTRUCTION_CHANNEL = new Set<ProviderKind>(["codex", "claudeAgent"]);

export function diagramCapabilityPreambleFor(provider: ProviderKind, isFirstTurn: boolean): string {
  if (!isFirstTurn) {
    return "";
  }
  if (PROVIDERS_WITH_SYSTEM_INSTRUCTION_CHANNEL.has(provider)) {
    return "";
  }
  return MERMAID_CAPABILITY_INSTRUCTION;
}
