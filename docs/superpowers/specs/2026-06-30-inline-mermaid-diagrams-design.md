# Inline Mermaid Diagram Rendering — Design

**Date:** 2026-06-30
**Status:** Approved (design); implementation pending
**Author:** Dylan + Claude (brainstorming session)

## Summary

Render Mermaid diagrams inline in the conversation, and reliably get the agent
to *produce* them — the way Traycer and the Claude desktop app do. Today Synara's
markdown renderer (`ChatMarkdown.tsx`) supports math (KaTeX), GFM tables/task
lists, Shiki-highlighted code, and images, but a ```` ```mermaid ```` block is
shown only as a highlighted code block, never a rendered diagram. And nothing
tells the agent that diagrams render, so it won't reach for one proactively.

"Solid" means two independent layers must both hold:

- **Layer 1 — Advertisement:** the model only reliably drafts renderable
  diagrams if it is *told* the capability exists (this is exactly how
  claude.ai Artifacts and Traycer do it — an explicit system-prompt
  instruction). Synara is multi-provider, so this must be wired per provider.
- **Layer 2 — Rendering:** whatever the model emits must render robustly and
  must *never* break the conversation (invalid syntax, partial streams, XSS).

## Goals

- Inline rendering of ```` ```mermaid ```` blocks in assistant/plan markdown,
  with the same polish as the existing image/code affordances (copy source,
  click-to-expand, light/dark theming).
- Advertise the capability to **every provider that exposes an instruction
  hook**, with a **render-only floor** everywhere else (best-effort across all 8
  providers — Codex, Claude, Cursor, Gemini, Grok, Kilo, OpenCode, Pi).
- Rendering is bulletproof: invalid Mermaid degrades to the source block,
  streaming never renders partial diagrams, and no unsanitized markup reaches the
  DOM.
- One source-of-truth wording for the capability instruction, reused at every
  injection point (no drift).

## Non-goals

- Non-Mermaid diagram/chart formats (Vega, Plotly, PlantUML, etc.). Math is
  already covered by KaTeX. The detection point is left pluggable for later.
- Artifact-style side-panel presentation (Claude desktop). v1 renders **inline**
  in the message flow, consistent with how Synara already renders images.
- Editing/round-tripping diagrams back to the agent.
- Changing how any provider is launched or how turns are transported.

## Current state

### Rendering (Layer 2 today)

- `apps/web/src/components/ChatMarkdown.tsx` is the single renderer for assistant
  and plan markdown: `react-markdown` v10 + `remark-gfm`, `remark-math`,
  `rehype-katex`.
- Fenced code blocks flow through the `pre` component override
  (`extractCodeBlock` → `parseCodeFenceInfo`) and render via a lazy-loaded Shiki
  path: `getSyntaxHighlightingModulePromise()` (memoized dynamic import),
  `SuspenseShikiCodeBlock` → `LoadedShikiCodeBlock` (cache lookup) →
  `UncachedShikiCodeBlock`, wrapped in `CodeHighlightErrorBoundary` + `Suspense`.
- A render cache keyed by `(code, language, theme)` lives in
  `apps/web/src/lib/syntaxHighlighting.ts` (LRU, ~500 entries / 50MB).
- `isStreaming` already flows into the code path and governs cache-write timing;
  `GeneratedMarkdownImage.tsx` is the reference for inline media with an
  expand/download overlay.

This is the architecture Layer 2 mirrors exactly, so the diagram path inherits
the same lazy-load, cache, error-boundary, streaming, and theming discipline.

### Advertisement injection points (Layer 1 today)

Mapped per provider:

| Provider | System/instruction hook | Mechanism |
|----------|------------------------|-----------|
| **Codex** | Yes (per-turn, system layer) | `developer_instructions` in `collaborationMode` — `codexAppServerManager.ts` (`CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS`, `CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS`) |
| **Claude** | Yes (all modes) | `systemPrompt.append` — `ClaudeAdapter.ts` (`EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND`) |
| Cursor | Plan mode text prefix only | `CursorAdapter.ts` |
| Grok | Plan mode text prefix only | `provider/planMode.ts` |
| Gemini | Plan mode text prefix only | `GeminiAdapter.ts` |
| OpenCode | Plan mode text prefix only | `OpenCodeAdapter.ts` |
| Kilo | Plan mode text prefix only | shares `OpenCodeAdapter.ts` |
| Pi | None (plan prefix not even applied) | `PiAdapter.ts` |

The one **universal** hook is the orchestration layer: `ProviderCommandReactor.ts`
(~lines 904–926) already inlines skill instructions into the outgoing provider
input via `buildInlineSkillInstructions`. A sibling step there can append a
capability preamble for any provider, in any mode.

## Design

### Layer 2 — Renderer

**New module `apps/web/src/lib/mermaidRendering.ts`** (mirrors
`syntaxHighlighting.ts`):

- Memoized `import("mermaid")` behind a module-level promise so Mermaid's heavy
  bundle (mermaid + dagre + d3) never lands in the initial chunk.
- One-time `mermaid.initialize({ startOnLoad: false, securityLevel: "strict",
  htmlLabels: false, theme: <mapped> })`.
- `renderMermaidToSvg(code, theme)` using `mermaid.parse` (validation) then
  `mermaid.render`. Throws on invalid input (caught upstream).
- Render cache keyed by `(code, mermaidTheme)`, same LRU shape and helpers as the
  Shiki cache (`createCacheKey` / `getCached` / `cache`).
- `resolveMermaidTheme(resolvedTheme)` maps Synara's light/dark to a Mermaid
  theme.

**New component `apps/web/src/components/chat/MermaidDiagram.tsx`:**

- Suspense + lazy module load identical in shape to `SuspenseShikiCodeBlock`.
- **Render-on-complete:** while `isStreaming`, render the raw fenced source
  (partial Mermaid is invalid); only render the diagram once the block is
  settled. Reuses the existing `isStreaming` signal.
- **Error fallback:** wrapped in `CodeHighlightErrorBoundary` + a `mermaid.parse`
  guard; invalid Mermaid falls back to the syntax-highlighted source block with a
  quiet "couldn't render diagram" affordance. Never blank, never throws to the
  timeline.
- **UX:** inline render with **copy-source** and **click-to-expand** (reusing the
  expand-overlay pattern from `GeneratedMarkdownImage` / `ExpandedImagePreview`),
  plus a rendered⇄source toggle.
- **Theme:** re-renders on theme switch; cache already keyed by theme.

**Wiring in `ChatMarkdown.tsx`:** in the existing `pre` override, after
`parseCodeFenceInfo`, branch when `fence.language === "mermaid"` to
`MermaidDiagram` instead of `SuspenseShikiCodeBlock`. Single-line branch; all
other fences unchanged.

### Layer 1 — Advertisement (Hybrid, approach A)

**One source-of-truth constant** `MERMAID_CAPABILITY_INSTRUCTION` in a shared
server module, reused at every injection point so wording never drifts. Draft
wording (concise, conditional to avoid over-use):

> When a diagram would make your answer clearer (architecture, flow, sequence,
> state), output it as a fenced ```` ```mermaid ```` code block — it renders
> inline for the user. Use it judiciously, not for trivial points.

Injection:

- **Codex** → append the constant to `CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS`
  and `CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS`. System layer; not conversation
  text.
- **Claude** → append to `EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND`. Applies all
  modes.
- **Cursor, Grok, Gemini, OpenCode, Kilo, Pi** → a new capability-preamble step
  at `ProviderCommandReactor.ts` (beside `buildInlineSkillInstructions`),
  **gated to the first turn of each provider thread**. These providers retain
  conversation history, so injecting once keeps the instruction in context
  without repeating it (and its token cost / history noise) every turn.
- **Floor:** render-only everywhere. A provider that never saw or ignored the
  instruction still gets any ```` ```mermaid ```` it emits rendered correctly.

**New state:** a per-thread "capability advertised" flag for the six text-based
providers (to inject on turn 1 only). Implementation will place this alongside
existing per-thread orchestration state in `ProviderCommandReactor` /
`providerManager`; if no natural home exists, it is a small, isolated addition.

### Cross-cutting

- **Security (sharp edge — SVG via `dangerouslySetInnerHTML`):**
  `securityLevel: "strict"` disables `click`/JS directives and external links;
  HTML labels off; Mermaid's built-in DOMPurify pass sanitizes output. No
  unsanitized markup reaches the DOM.
- **Performance:** lazy-load + render cache as above; no diagram work during
  streaming flushes.

## Testing

- `ChatMarkdown`: ```` ```mermaid ```` routes to `MermaidDiagram`; all other
  fences still route to Shiki.
- Invalid Mermaid → source-block fallback (no throw).
- Streaming → source first, diagram after completion.
- Theme switch → re-render; cache hit on repeat `(code, theme)`.
- Layer 1: the `MERMAID_CAPABILITY_INSTRUCTION` constant is wired into the Codex
  constants, the Claude append, and the orchestration first-turn preamble; the
  six text-based providers receive it exactly once per thread.
- Final gate: `bun fmt`, `bun lint`, `bun typecheck`.

## Open questions (resolve during planning)

- Exact home for the per-thread "advertised" flag in orchestration state.
- Final Mermaid theme mapping to match Synara's design tokens (custom theme vs.
  built-in `default`/`dark`).
- Whether the expand overlay can reuse `ExpandedImagePreview` directly (it is
  image-oriented) or needs a thin SVG-aware variant.
