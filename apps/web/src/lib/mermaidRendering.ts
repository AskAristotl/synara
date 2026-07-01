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
  mermaidModulePromise ??= import("mermaid")
    .then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    })
    .catch((error: unknown) => {
      // Drop the failed promise so a later retry (e.g. transient chunk-load
      // failure) can re-import and re-initialize instead of wedging every
      // future render behind the same rejected singleton.
      mermaidModulePromise = null;
      throw error;
    });
  return mermaidModulePromise;
}

/** Test-only hook to clear the memoized module promise between test cases. */
export function resetMermaidModuleForTests(): void {
  mermaidModulePromise = null;
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
    .finally(() => {
      // Drop the settled promise so it is not pinned here forever. The LRU
      // (mermaidSvgCache) is the durable memo — keeping every resolved promise
      // in this Map would hold its SVG strongly and defeat the LRU's memory cap.
      // Cache-first lookups serve re-renders; an LRU eviction correctly triggers
      // a fresh render, and a failed render is likewise freed for retry.
      svgPromiseCache.delete(cacheKey);
    });
  svgPromiseCache.set(cacheKey, promise);
  return promise;
}
