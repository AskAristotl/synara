# Inline Mermaid Diagram Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render ` ```mermaid ` fenced blocks as inline diagrams in chat markdown, and reliably tell each provider's model that it can draft them.

**Architecture:** Layer 2 (renderer) mirrors the existing lazy-loaded Shiki path in `ChatMarkdown.tsx` — a memoized dynamic `import("mermaid")`, an LRU render cache keyed by `(code, theme)`, a cache-first synchronous render with a Suspense fallback for the uncached path, an error boundary that falls back to the source block, and render-on-complete gated by `isStreaming`. Layer 1 (advertisement) is a single source-of-truth instruction constant, injected via each provider's cleanest channel: Codex `developer_instructions`, Claude `systemPrompt.append`, and a first-turn-only orchestration preamble for the six providers with no system channel.

**Tech Stack:** React 18 + `react-markdown` v10, `mermaid` v11, Vitest, Effect (server orchestration), TypeScript, Bun.

## Global Constraints

- All of `bun fmt`, `bun lint`, `bun typecheck` must pass before a task is complete. Run them as one final pass per task, not repeatedly mid-iteration.
- NEVER run `bun test`. Always use `bun run test` (Vitest).
- Do NOT add AI attribution trailers to commits (no `Co-Authored-By`, no `Claude-Session`).
- One source-of-truth wording for the capability instruction (`MERMAID_CAPABILITY_INSTRUCTION`), reused at every injection point — no duplicated wording (DRY).
- Mermaid must be lazy-loaded (never in the initial chunk) and initialized with `securityLevel: "strict"` and `flowchart: { htmlLabels: false }`.
- Rendering must never crash the timeline: invalid Mermaid falls back to the source block; partial Mermaid is never rendered while streaming.
- v1 is Mermaid only. No other diagram/chart formats.

---

### Task 1: Mermaid rendering module

**Files:**

- Modify: `apps/web/package.json` (add `mermaid` dependency)
- Create: `apps/web/src/lib/mermaidRendering.ts`
- Test: `apps/web/src/lib/mermaidRendering.test.ts`

**Interfaces:**

- Consumes: `fnv1a32` from `./diffRendering`, `LRUCache` from `./lruCache` (existing; `LRUCache<T>(maxEntries, maxBytes)` with `.get(key): T | null` and `.set(key, value, sizeBytes)`).
- Produces:
  - `type MermaidTheme = "default" | "dark"`
  - `resolveMermaidTheme(resolvedTheme: "light" | "dark"): MermaidTheme`
  - `createMermaidCacheKey(code: string, theme: MermaidTheme): string`
  - `getCachedMermaidSvg(cacheKey: string): string | null`
  - `getMermaidModulePromise(): Promise<MermaidModule>`
  - `getMermaidSvgPromise(code: string, theme: MermaidTheme): Promise<string>`

- [ ] **Step 1: Add the dependency**

Add to `apps/web/package.json` under `"dependencies"` (keep alphabetical ordering near the existing `"katex"` / `"react-markdown"` entries):

```json
"mermaid": "^11.6.0",
```

Then install:

Run: `bun install`
Expected: exits 0; `mermaid` present in `apps/web/node_modules`.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/lib/mermaidRendering.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
const parseMock = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: parseMock,
    render: renderMock,
  },
}));

import {
  createMermaidCacheKey,
  getCachedMermaidSvg,
  getMermaidSvgPromise,
  resolveMermaidTheme,
} from "./mermaidRendering";

describe("mermaidRendering", () => {
  beforeEach(() => {
    renderMock.mockReset();
    parseMock.mockReset();
  });

  it("maps app theme to a mermaid theme", () => {
    expect(resolveMermaidTheme("dark")).toBe("dark");
    expect(resolveMermaidTheme("light")).toBe("default");
  });

  it("cache key is stable for identical inputs and varies by theme", () => {
    const a = createMermaidCacheKey("graph TD;A-->B", "default");
    const b = createMermaidCacheKey("graph TD;A-->B", "default");
    const c = createMermaidCacheKey("graph TD;A-->B", "dark");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("renders and caches the svg", async () => {
    parseMock.mockResolvedValue(true);
    renderMock.mockResolvedValue({ svg: "<svg>ok</svg>" });

    const svg = await getMermaidSvgPromise("graph TD;A-->B", "default");

    expect(svg).toBe("<svg>ok</svg>");
    expect(getCachedMermaidSvg(createMermaidCacheKey("graph TD;A-->B", "default"))).toBe(
      "<svg>ok</svg>",
    );
  });

  it("rejects and does not cache on invalid mermaid", async () => {
    parseMock.mockRejectedValue(new Error("parse error"));

    await expect(getMermaidSvgPromise("not a diagram", "default")).rejects.toThrow("parse error");
    expect(getCachedMermaidSvg(createMermaidCacheKey("not a diagram", "default"))).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test apps/web/src/lib/mermaidRendering.test.ts`
Expected: FAIL — module `./mermaidRendering` does not exist.

- [ ] **Step 4: Write the module**

Create `apps/web/src/lib/mermaidRendering.ts`:

```ts
// FILE: mermaidRendering.ts
// Purpose: Lazy Mermaid loader + render cache for inline diagrams in chat markdown.
// Layer: Web UI utility
// Depends on: mermaid (dynamic import), shared fnv1a32 hash and LRU cache.

import { fnv1a32 } from "./diffRendering";
import { LRUCache } from "./lruCache";

export type MermaidTheme = "default" | "dark";

type MermaidModule = (typeof import("mermaid"))["default"];

const MAX_MERMAID_CACHE_ENTRIES = 200;
const MAX_MERMAID_CACHE_MEMORY_BYTES = 25 * 1024 * 1024;

const mermaidSvgCache = new LRUCache<string>(
  MAX_MERMAID_CACHE_ENTRIES,
  MAX_MERMAID_CACHE_MEMORY_BYTES,
);
const svgPromiseCache = new Map<string, Promise<string>>();

let mermaidModulePromise: Promise<MermaidModule> | null = null;
let renderCounter = 0;

export function resolveMermaidTheme(resolvedTheme: "light" | "dark"): MermaidTheme {
  return resolvedTheme === "dark" ? "dark" : "default";
}

export function createMermaidCacheKey(code: string, theme: MermaidTheme): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${theme}`;
}

export function getCachedMermaidSvg(cacheKey: string): string | null {
  return mermaidSvgCache.get(cacheKey);
}

function cacheMermaidSvg(cacheKey: string, svg: string, code: string): void {
  mermaidSvgCache.set(cacheKey, svg, Math.max(svg.length * 2, code.length * 3));
}

export function getMermaidModulePromise(): Promise<MermaidModule> {
  mermaidModulePromise ??= import("mermaid").then((mod) => {
    const mermaid = mod.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      flowchart: { htmlLabels: false },
    });
    return mermaid;
  });
  return mermaidModulePromise;
}

async function renderMermaidToSvg(
  mermaid: MermaidModule,
  code: string,
  theme: MermaidTheme,
): Promise<string> {
  // Theme per-diagram via an init directive so concurrent light/dark renders never
  // race on mermaid's global config. Cache key already includes the theme.
  const themed = `%%{init: {"theme":"${theme}"}}%%\n${code}`;
  // Throws on invalid syntax; the caller lets the rejection reach the error boundary.
  await mermaid.parse(themed);
  renderCounter += 1;
  const { svg } = await mermaid.render(`synara-mermaid-${renderCounter}`, themed);
  return svg;
}

export function getMermaidSvgPromise(code: string, theme: MermaidTheme): Promise<string> {
  const cacheKey = createMermaidCacheKey(code, theme);
  const cachedPromise = svgPromiseCache.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }

  const promise = getMermaidModulePromise()
    .then((mermaid) => renderMermaidToSvg(mermaid, code, theme))
    .then((svg) => {
      cacheMermaidSvg(cacheKey, svg, code);
      return svg;
    })
    .catch((error: unknown) => {
      // Drop the failed promise so a later retry (e.g. after an edit) can re-render.
      svgPromiseCache.delete(cacheKey);
      throw error;
    });
  svgPromiseCache.set(cacheKey, promise);
  return promise;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test apps/web/src/lib/mermaidRendering.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/lib/mermaidRendering.ts apps/web/src/lib/mermaidRendering.test.ts bun.lock
git commit -m "feat(web): add lazy mermaid rendering module with render cache"
```

---

### Task 2: Extract the code-highlight error boundary

Extracts the existing `CodeHighlightErrorBoundary` (currently private in `ChatMarkdown.tsx`, lines 62–81) into a shared file so the new diagram component reuses it instead of duplicating a boundary. Behavior is unchanged; the existing `ChatMarkdown` tests are the regression check.

**Files:**

- Create: `apps/web/src/components/chat/CodeHighlightErrorBoundary.tsx`
- Modify: `apps/web/src/components/ChatMarkdown.tsx` (remove the inline class, import the extracted one)
- Test: `apps/web/src/components/ChatMarkdown.test.tsx` (existing — must still pass)

**Interfaces:**

- Produces: `CodeHighlightErrorBoundary` React component with props `{ fallback: ReactNode; children: ReactNode }`.

- [ ] **Step 1: Create the shared component**

Create `apps/web/src/components/chat/CodeHighlightErrorBoundary.tsx`:

```tsx
// FILE: CodeHighlightErrorBoundary.tsx
// Purpose: Renders a fallback when a code/diagram highlighter throws, so a single
//          bad block never takes down the surrounding markdown timeline.
// Layer: Web chat presentation component

import React, { type ReactNode } from "react";

export class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: Remove the inline boundary and import the shared one in `ChatMarkdown.tsx`**

Delete the inline class declaration at `apps/web/src/components/ChatMarkdown.tsx:62-81` (the `class CodeHighlightErrorBoundary extends React.Component<...> { ... }` block).

Add this import alongside the other component imports near the top (after the `IconButton` import at line 48):

```tsx
import { CodeHighlightErrorBoundary } from "./chat/CodeHighlightErrorBoundary";
```

- [ ] **Step 3: Run the existing markdown tests to verify no regression**

Run: `bun run test apps/web/src/components/ChatMarkdown.test.tsx`
Expected: PASS (all existing tests unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/chat/CodeHighlightErrorBoundary.tsx apps/web/src/components/ChatMarkdown.tsx
git commit -m "refactor(web): extract CodeHighlightErrorBoundary for reuse"
```

---

### Task 3: Mermaid diagram component

**Files:**

- Create: `apps/web/src/components/chat/MermaidDiagram.tsx`
- Modify: `apps/web/src/index.css` (add `.chat-markdown-mermaid` sizing)
- Test: `apps/web/src/components/chat/MermaidDiagram.test.tsx`

**Interfaces:**

- Consumes: `getCachedMermaidSvg`, `createMermaidCacheKey`, `getMermaidSvgPromise`, `resolveMermaidTheme`, `type MermaidTheme` from `../../lib/mermaidRendering`; `CodeHighlightErrorBoundary` from `./CodeHighlightErrorBoundary`; `copyTextToClipboard` from `../../hooks/useCopyToClipboard`; `CheckIcon`, `CopyIcon`, `Maximize2` from `~/lib/icons`; `type ExpandedImagePreview` from `./ExpandedImagePreview`.
- Produces: default export `MermaidDiagram` with props
  `{ code: string; resolvedTheme: "light" | "dark"; isStreaming: boolean; onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined; sourceFallback: ReactNode }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/chat/MermaidDiagram.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const getCachedMermaidSvgMock = vi.fn();
const getMermaidSvgPromiseMock = vi.fn();

vi.mock("../../lib/mermaidRendering", () => ({
  resolveMermaidTheme: (t: "light" | "dark") => (t === "dark" ? "dark" : "default"),
  createMermaidCacheKey: () => "key",
  getCachedMermaidSvg: getCachedMermaidSvgMock,
  getMermaidSvgPromise: getMermaidSvgPromiseMock,
}));

async function render(props: { isStreaming: boolean; cachedSvg: string | null }) {
  getCachedMermaidSvgMock.mockReturnValue(props.cachedSvg);
  getMermaidSvgPromiseMock.mockReturnValue(new Promise<string>(() => {}));
  const { default: MermaidDiagram } = await import("./MermaidDiagram");
  return renderToStaticMarkup(
    <MermaidDiagram
      code="graph TD;A-->B"
      resolvedTheme="light"
      isStreaming={props.isStreaming}
      sourceFallback={<pre>SOURCE_BLOCK</pre>}
    />,
  );
}

describe("MermaidDiagram", () => {
  it("renders the source block while streaming", async () => {
    const markup = await render({ isStreaming: true, cachedSvg: "<svg>diagram</svg>" });
    expect(markup).toContain("SOURCE_BLOCK");
    expect(markup).not.toContain("<svg>diagram</svg>");
  });

  it("renders the cached svg when settled", async () => {
    const markup = await render({ isStreaming: false, cachedSvg: "<svg>diagram</svg>" });
    expect(markup).toContain("<svg>diagram</svg>");
  });

  it("falls back to the source block while an uncached render is pending", async () => {
    const markup = await render({ isStreaming: false, cachedSvg: null });
    expect(markup).toContain("SOURCE_BLOCK");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test apps/web/src/components/chat/MermaidDiagram.test.tsx`
Expected: FAIL — module `./MermaidDiagram` does not exist.

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/chat/MermaidDiagram.tsx`:

````tsx
// FILE: MermaidDiagram.tsx
// Purpose: Render a ```mermaid fenced block inline — lazy-loaded, cache-first, render-on-complete,
//          with an error/streaming fallback to the source block plus copy + expand affordances.
// Layer: Web chat presentation component
// Exports: MermaidDiagram (default)

import { type MouseEvent, Suspense, use, useCallback, useState, type ReactNode } from "react";

import { CheckIcon, CopyIcon, Maximize2 } from "~/lib/icons";

import { copyTextToClipboard } from "../../hooks/useCopyToClipboard";
import {
  createMermaidCacheKey,
  getCachedMermaidSvg,
  getMermaidSvgPromise,
  resolveMermaidTheme,
  type MermaidTheme,
} from "../../lib/mermaidRendering";
import { CodeHighlightErrorBoundary } from "./CodeHighlightErrorBoundary";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface MermaidDiagramProps {
  code: string;
  resolvedTheme: "light" | "dark";
  isStreaming: boolean;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  sourceFallback: ReactNode;
}

function MermaidFrame({
  svg,
  code,
  onImageExpand,
}: {
  svg: string;
  code: string;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  }, [code]);

  const handleExpand = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      onImageExpand?.({
        images: [{ src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, name: "Diagram" }],
        index: 0,
      });
    },
    [onImageExpand, svg],
  );

  return (
    <div className="chat-markdown-mermaid" data-diagram="true">
      <div className="chat-markdown-mermaid__actions">
        {onImageExpand ? (
          <button
            type="button"
            className="chat-markdown-mermaid__action"
            onClick={handleExpand}
            title="Expand diagram"
            aria-label="Expand diagram"
          >
            <Maximize2 className="size-3" />
          </button>
        ) : null}
        <button
          type="button"
          className="chat-markdown-mermaid__action"
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy diagram source"}
          aria-label={copied ? "Copied" : "Copy diagram source"}
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </button>
      </div>
      {/* svg is produced by mermaid with securityLevel: "strict" (DOMPurify-sanitized). */}
      <div className="chat-markdown-mermaid__svg" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

function SuspendedMermaidFrame({
  code,
  theme,
  onImageExpand,
}: {
  code: string;
  theme: MermaidTheme;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const svg = use(getMermaidSvgPromise(code, theme));
  return <MermaidFrame svg={svg} code={code} onImageExpand={onImageExpand} />;
}

export default function MermaidDiagram({
  code,
  resolvedTheme,
  isStreaming,
  onImageExpand,
  sourceFallback,
}: MermaidDiagramProps) {
  // Partial mermaid mid-stream is invalid; show the source until the block settles.
  if (isStreaming) {
    return <>{sourceFallback}</>;
  }

  const theme = resolveMermaidTheme(resolvedTheme);
  const cachedSvg = getCachedMermaidSvg(createMermaidCacheKey(code, theme));
  if (cachedSvg != null) {
    return <MermaidFrame svg={cachedSvg} code={code} onImageExpand={onImageExpand} />;
  }

  return (
    <CodeHighlightErrorBoundary fallback={sourceFallback}>
      <Suspense fallback={sourceFallback}>
        <SuspendedMermaidFrame code={code} theme={theme} onImageExpand={onImageExpand} />
      </Suspense>
    </CodeHighlightErrorBoundary>
  );
}
````

- [ ] **Step 4: Add minimal styling**

Append to `apps/web/src/index.css`:

```css
.chat-markdown-mermaid {
  position: relative;
  margin: 0.5rem 0;
}
.chat-markdown-mermaid__svg svg {
  max-width: 100%;
  height: auto;
}
.chat-markdown-mermaid__actions {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  display: flex;
  gap: 0.25rem;
  opacity: 0;
  transition: opacity 150ms ease-out;
}
.chat-markdown-mermaid:hover .chat-markdown-mermaid__actions {
  opacity: 1;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test apps/web/src/components/chat/MermaidDiagram.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/MermaidDiagram.tsx apps/web/src/components/chat/MermaidDiagram.test.tsx apps/web/src/index.css
git commit -m "feat(web): add inline MermaidDiagram component"
```

---

### Task 4: Route mermaid fences in ChatMarkdown

**Files:**

- Modify: `apps/web/src/components/ChatMarkdown.tsx` (the `pre` component override, lines 1028–1051)
- Test: `apps/web/src/components/ChatMarkdown.test.tsx` (add cases)

**Interfaces:**

- Consumes: default `MermaidDiagram` from `./chat/MermaidDiagram`.
- Produces: no new exports; ` ```mermaid ` fences now render via `MermaidDiagram`.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/ChatMarkdown.test.tsx` inside the `describe("ChatMarkdown", ...)` block:

````tsx
it("routes a mermaid fence to the diagram component", async () => {
  const markup = await renderMarkdown("```mermaid\ngraph TD;A-->B\n```");
  expect(markup).toContain("chat-markdown-mermaid");
});

it("still routes non-mermaid fences to the code block", async () => {
  const markup = await renderMarkdown("```ts\nconst x = 1;\n```");
  expect(markup).not.toContain("chat-markdown-mermaid");
  expect(markup).toContain("chat-markdown-codeblock");
});
````

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test apps/web/src/components/ChatMarkdown.test.tsx -t "routes a mermaid fence"`
Expected: FAIL — markup does not contain `chat-markdown-mermaid`.

- [ ] **Step 3: Add the import**

In `apps/web/src/components/ChatMarkdown.tsx`, add near the other `./chat/*` imports (after the `GeneratedMarkdownImage` import at line 41):

```tsx
import MermaidDiagram from "./chat/MermaidDiagram";
```

- [ ] **Step 4: Branch the `pre` override**

Replace the body of the `pre` override (currently `apps/web/src/components/ChatMarkdown.tsx:1028-1051`) with a version that builds the Shiki block once and reuses it as the mermaid source fallback:

```tsx
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        const fence = parseCodeFenceInfo(extractRawFenceInfo(codeBlock.className));
        const code = dedentCode(codeBlock.code);

        const shikiCodeBlock = (
          <MarkdownCodeBlock code={code} fence={fence}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  language={fence.language}
                  code={code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );

        if (fence.language === "mermaid") {
          return (
            <MermaidDiagram
              code={code}
              resolvedTheme={resolvedTheme}
              isStreaming={isStreaming}
              onImageExpand={onImageExpand}
              sourceFallback={shikiCodeBlock}
            />
          );
        }

        return shikiCodeBlock;
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test apps/web/src/components/ChatMarkdown.test.tsx`
Expected: PASS (existing tests + the two new cases).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ChatMarkdown.tsx apps/web/src/components/ChatMarkdown.test.tsx
git commit -m "feat(web): render mermaid fences as inline diagrams"
```

---

### Task 5: Shared capability constant + provider helper

**Files:**

- Create: `apps/server/src/provider/diagramCapability.ts`
- Test: `apps/server/src/provider/diagramCapability.test.ts`

**Interfaces:**

- Consumes: `type ProviderKind` from `@t3tools/contracts`.
- Produces:
  - `MERMAID_CAPABILITY_INSTRUCTION: string`
  - `diagramCapabilityPreambleFor(provider: ProviderKind, isFirstTurn: boolean): string`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/provider/diagramCapability.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { MERMAID_CAPABILITY_INSTRUCTION, diagramCapabilityPreambleFor } from "./diagramCapability";

describe("diagramCapability", () => {
  it("instruction mentions the mermaid fence", () => {
    expect(MERMAID_CAPABILITY_INSTRUCTION.toLowerCase()).toContain("mermaid");
  });

  it("returns the preamble for a no-system-channel provider on the first turn", () => {
    expect(diagramCapabilityPreambleFor("cursor", true)).toBe(MERMAID_CAPABILITY_INSTRUCTION);
    expect(diagramCapabilityPreambleFor("pi", true)).toBe(MERMAID_CAPABILITY_INSTRUCTION);
  });

  it("returns nothing after the first turn", () => {
    expect(diagramCapabilityPreambleFor("cursor", false)).toBe("");
  });

  it("returns nothing for providers advertised via their system channel", () => {
    expect(diagramCapabilityPreambleFor("codex", true)).toBe("");
    expect(diagramCapabilityPreambleFor("claudeAgent", true)).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test apps/server/src/provider/diagramCapability.test.ts`
Expected: FAIL — module `./diagramCapability` does not exist.

- [ ] **Step 3: Write the module**

Create `apps/server/src/provider/diagramCapability.ts`:

````ts
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
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test apps/server/src/provider/diagramCapability.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/diagramCapability.ts apps/server/src/provider/diagramCapability.test.ts
git commit -m "feat(server): add shared mermaid capability instruction + provider rule"
```

---

### Task 6: Advertise to Codex and Claude via their system channels

**Files:**

- Modify: `apps/server/src/codexAppServerManager.ts` (append to both developer-instruction constants, lines 328–461)
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (add to and export the system-prompt append, lines 805–810)
- Test: `apps/server/src/provider/diagramCapability.wiring.test.ts`

**Interfaces:**

- Consumes: `MERMAID_CAPABILITY_INSTRUCTION` from `./provider/diagramCapability` (Codex) and `../diagramCapability` (Claude).
- Produces: `EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND` becomes an exported constant from `ClaudeAdapter.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/provider/diagramCapability.wiring.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../../codexAppServerManager";
import { EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND } from "./Layers/ClaudeAdapter";
import { MERMAID_CAPABILITY_INSTRUCTION } from "./diagramCapability";

describe("diagram capability wiring", () => {
  it("codex default + plan instructions include the capability", () => {
    expect(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS).toContain(MERMAID_CAPABILITY_INSTRUCTION);
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain(MERMAID_CAPABILITY_INSTRUCTION);
  });

  it("claude system prompt append includes the capability", () => {
    expect(EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND).toContain(MERMAID_CAPABILITY_INSTRUCTION);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test apps/server/src/provider/diagramCapability.wiring.test.ts`
Expected: FAIL — `EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND` is not exported and the Codex constants lack the instruction.

- [ ] **Step 3: Wire Codex**

In `apps/server/src/codexAppServerManager.ts`, add the import near the top with the other local imports:

```ts
import { MERMAID_CAPABILITY_INSTRUCTION } from "./provider/diagramCapability";
```

Add this constant immediately after `CODEX_BROWSER_TOOL_ROUTING_INSTRUCTIONS` (after line 326):

```ts
const CODEX_DIAGRAM_INSTRUCTIONS = `\n\n## Diagrams\n\n${MERMAID_CAPABILITY_INSTRUCTION}`;
```

Then append it to both constants. Change the tail of `CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS` (line 448) from:

```ts
</collaboration_mode>${CODEX_BROWSER_TOOL_ROUTING_INSTRUCTIONS}`;
```

to:

```ts
</collaboration_mode>${CODEX_BROWSER_TOOL_ROUTING_INSTRUCTIONS}${CODEX_DIAGRAM_INSTRUCTIONS}`;
```

And the tail of `CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS` (line 461) the same way:

```ts
</collaboration_mode>${CODEX_BROWSER_TOOL_ROUTING_INSTRUCTIONS}${CODEX_DIAGRAM_INSTRUCTIONS}`;
```

- [ ] **Step 4: Wire Claude**

In `apps/server/src/provider/Layers/ClaudeAdapter.ts`, add the import near the other provider-local imports:

```ts
import { MERMAID_CAPABILITY_INSTRUCTION } from "../diagramCapability";
```

Change the declaration at lines 805–810 from `const EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND = [ ... ].join("\n");` to export it and include the instruction as a final line:

```ts
export const EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND = [
  "You are running inside Synara, a coding app that embeds the Claude Agent SDK.",
  "Do not present the host app as Claude Code unless the user is explicitly asking about Claude Code.",
  "Treat the current working directory as the active workspace for the task.",
  "When the user asks about the current project, codebase, or repository, proactively inspect files in the current working directory before asking the user where to look.",
  MERMAID_CAPABILITY_INSTRUCTION,
].join("\n");
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test apps/server/src/provider/diagramCapability.wiring.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/codexAppServerManager.ts apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/diagramCapability.wiring.test.ts
git commit -m "feat(server): advertise mermaid capability to codex and claude"
```

---

### Task 7: First-turn preamble for the remaining providers

Wires the pure helper (already unit-tested in Task 5) into the orchestration turn builder for the six providers that have no system channel, gated to the first turn of a thread via the existing `activeSessionBeforeEnsure === undefined` signal (no new state).

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` (import + fold into the composed input near lines 903–933)

**Interfaces:**

- Consumes: `diagramCapabilityPreambleFor` from `../../provider/diagramCapability`; existing in-scope `selectedProvider`, `activeSessionBeforeEnsure`, `providerInputWithSkills`.
- Produces: no new exports.

- [ ] **Step 1: Add the import**

In `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, add with the other `../../provider/*` imports:

```ts
import { diagramCapabilityPreambleFor } from "../../provider/diagramCapability";
```

- [ ] **Step 2: Fold the preamble into the composed input**

Immediately after the `providerInputWithSkills` assignment (currently lines 924–926), insert:

```ts
// Providers without a system-prompt channel are told once, on the first turn of
// the thread, that they can draft renderable mermaid diagrams. Codex/Claude get
// this via their system channels instead, so the helper returns "" for them.
const diagramCapabilityText = diagramCapabilityPreambleFor(
  selectedProvider as ProviderKind,
  activeSessionBeforeEnsure === undefined,
);
const providerInputWithCapability = diagramCapabilityText
  ? `${providerInputWithSkills}\n\n${diagramCapabilityText}`
  : providerInputWithSkills;
```

Then change the `normalizeSkillMentionTextForProvider` call (currently line 930) to consume the new variable:

```ts
const normalizedInput = toNonEmptyProviderInput(
  normalizeSkillMentionTextForProvider({
    provider: selectedProvider as ProviderKind,
    messageText: providerInputWithCapability,
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
  }),
);
```

- [ ] **Step 3: Verify the build and full check pass**

The capability logic itself is already unit-tested in Task 5; this task is the wiring, verified by types and the full check.

Run: `bun typecheck`
Expected: exits 0 (the new variable and import type-check; `selectedProvider as ProviderKind` matches the helper signature).

Run: `bun run test apps/server/src/provider/diagramCapability.test.ts`
Expected: PASS (the helper behavior this wiring depends on is green).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
git commit -m "feat(server): advertise mermaid capability to remaining providers on first turn"
```

---

### Task 8: Final verification pass

**Files:** none (workspace-wide checks only).

- [ ] **Step 1: Run the full check suite once**

Run: `bun fmt && bun lint && bun typecheck`
Expected: all three exit 0. Fix any reported issues, then re-run.

- [ ] **Step 2: Run the full test suite**

Run: `bun run test`
Expected: all tests pass, including the new `mermaidRendering`, `MermaidDiagram`, `ChatMarkdown`, `diagramCapability`, and `diagramCapability.wiring` tests.

- [ ] **Step 3: Commit any formatting-only changes**

```bash
git add -A
git commit -m "chore: formatting for mermaid diagram feature" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**

- Layer 2 renderer (lazy-load, cache, render-on-complete, error fallback, theme) → Tasks 1–4.
- Inline UX with copy + expand → Task 3 (`MermaidFrame`).
- Security (`securityLevel: "strict"`, `htmlLabels: false`) → Task 1 (`getMermaidModulePromise`).
- Layer 1 single source-of-truth constant → Task 5.
- Codex + Claude system-channel injection → Task 6.
- First-turn preamble for the other six, render-only floor → Task 7 (helper returns "" for codex/claude; render-only is inherent because Task 4 renders any mermaid fence regardless of advertisement).
- Mermaid-only scope, no other formats → honored throughout (only `fence.language === "mermaid"` branches).
- Testing + `bun fmt`/`lint`/`typecheck` gate → Tasks 1–8.

**Resolved open questions from the spec:**

- Per-thread "advertised" flag home → reuses existing `activeSessionBeforeEnsure === undefined`; no new state.
- Expand overlay reuse → `MermaidFrame` serializes the SVG to a `data:image/svg+xml` URL and reuses the existing `ExpandedImagePreview` / `onImageExpand` contract, no image-specific variant needed.
- Mermaid theme mapping → `resolveMermaidTheme` maps light→`default`, dark→`dark`, applied per-diagram via an `%%{init}%%` directive.

**Placeholder scan:** none — every step has concrete code or an exact command with expected output.

**Type consistency:** `MermaidTheme`, `createMermaidCacheKey`, `getCachedMermaidSvg`, `getMermaidSvgPromise`, `resolveMermaidTheme` are defined in Task 1 and consumed with matching signatures in Task 3; `MERMAID_CAPABILITY_INSTRUCTION` / `diagramCapabilityPreambleFor` defined in Task 5 and consumed in Tasks 6–7; `CodeHighlightErrorBoundary` extracted in Task 2 and consumed in Tasks 3–4.
