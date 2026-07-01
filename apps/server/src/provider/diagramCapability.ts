// FILE: diagramCapability.ts
// Purpose: Single source-of-truth instructions telling a provider's model which content it
//          can emit for Synara to render inline — Mermaid diagrams and sandboxed HTML
//          previews — plus the rule for which providers receive them via a first-turn prompt
//          preamble (those without a dedicated system-prompt channel).
// Layer: Server provider helper
// Exports: MERMAID_CAPABILITY_INSTRUCTION, HTML_PREVIEW_CAPABILITY_INSTRUCTION,
//          RENDERABLE_CAPABILITIES_INSTRUCTION, renderableCapabilitiesPreambleFor

import type { ProviderKind } from "@t3tools/contracts";

export const MERMAID_CAPABILITY_INSTRUCTION =
  "When a diagram would make your answer clearer (architecture, control/data flow, " +
  "sequences, state machines), output it as a fenced ```mermaid code block. Synara " +
  "renders it inline for the user. Use diagrams judiciously — only when they add real " +
  "clarity, not for trivial points.";

export const HTML_PREVIEW_CAPABILITY_INSTRUCTION =
  "When showing a UI snippet or visual design (e.g. button or component variants, a card, " +
  "a small layout), output it as a fenced ```html-preview code block holding a " +
  "self-contained HTML fragment. Synara renders it live and sandboxed inline: CSS is " +
  "honored (including <style> blocks and :hover/:focus/@keyframes), but scripts are " +
  "stripped, so rely on CSS for any interactivity — never depend on JavaScript. Use a plain " +
  "```html block instead when you want to show HTML as source code rather than render it. " +
  "Keep previews small and self-contained.";

// Combined instruction advertised to a model via its system/developer channel or a
// first-turn preamble. Ordered diagrams-then-preview to match how they were introduced.
export const RENDERABLE_CAPABILITIES_INSTRUCTION = [
  MERMAID_CAPABILITY_INSTRUCTION,
  HTML_PREVIEW_CAPABILITY_INSTRUCTION,
].join("\n\n");

// Providers that expose a dedicated system/developer instruction channel get the
// capabilities advertised there (see codexAppServerManager.ts and ClaudeAdapter.ts),
// so they must NOT also receive the prompt preamble. Every other provider (cursor,
// gemini, grok, kilo, opencode, pi) has no such channel and gets a first-turn preamble.
const PROVIDERS_WITH_SYSTEM_INSTRUCTION_CHANNEL = new Set<ProviderKind>(["codex", "claudeAgent"]);

export function renderableCapabilitiesPreambleFor(
  provider: ProviderKind,
  isFirstTurn: boolean,
): string {
  if (!isFirstTurn) {
    return "";
  }
  if (PROVIDERS_WITH_SYSTEM_INSTRUCTION_CHANNEL.has(provider)) {
    return "";
  }
  return RENDERABLE_CAPABILITIES_INSTRUCTION;
}
