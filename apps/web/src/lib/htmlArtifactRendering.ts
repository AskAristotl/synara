// FILE: htmlArtifactRendering.ts
// Purpose: Lazy DOMPurify loader + sanitize cache for inline ```html-preview artifacts in
//          chat markdown. Sanitizes agent-authored HTML into a safe, script-free string that
//          the HtmlArtifact component renders inside a style-isolated shadow root.
// Layer: Web UI utility
// Depends on: dompurify (dynamic import), shared fnv1a32 hash and LRU cache.

import { fnv1a32 } from "./diffRendering";
import { LRUCache } from "./lruCache";

type DomPurify = (typeof import("dompurify"))["default"];

const MAX_HTML_ARTIFACT_CACHE_ENTRIES = 100;
const MAX_HTML_ARTIFACT_CACHE_MEMORY_BYTES = 10 * 1024 * 1024;

const sanitizedHtmlCache = new LRUCache<string>(
  MAX_HTML_ARTIFACT_CACHE_ENTRIES,
  MAX_HTML_ARTIFACT_CACHE_MEMORY_BYTES,
);
const sanitizePromiseCache = new Map<string, Promise<string>>();

let domPurifyModulePromise: Promise<DomPurify> | null = null;

// Sanitize policy: keep the visual/CSS surface (elements, classes, inline `style`,
// `<style>` blocks with :hover/@keyframes) but drop everything executable or
// navigating. DOMPurify already strips `<script>`, `on*` handlers and `javascript:`
// URLs by default; the explicit lists below additionally remove framing, external
// resource loads and form submission, so a preview can neither run JS nor
// redirect/phone out on its own.
const SANITIZE_CONFIG = {
  FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "meta", "link", "form"],
  FORBID_ATTR: ["action", "formaction", "ping", "target"],
};

export function createHtmlArtifactCacheKey(code: string): string {
  return `${fnv1a32(code).toString(36)}:${code.length}`;
}

export function getCachedSanitizedHtml(cacheKey: string): string | null {
  return sanitizedHtmlCache.get(cacheKey);
}

function cacheSanitizedHtml(cacheKey: string, html: string, code: string): void {
  sanitizedHtmlCache.set(cacheKey, html, Math.max(html.length * 2, code.length * 2));
}

export function getDomPurifyModulePromise(): Promise<DomPurify> {
  domPurifyModulePromise ??= import("dompurify")
    .then((mod) => mod.default)
    .catch((error: unknown) => {
      // Drop the failed promise so a later retry (e.g. a transient chunk-load
      // failure) can re-import instead of wedging every future sanitize behind
      // the same rejected singleton.
      domPurifyModulePromise = null;
      throw error;
    });
  return domPurifyModulePromise;
}

/** Test-only hook to clear the memoized module promise between test cases. */
export function resetHtmlArtifactModuleForTests(): void {
  domPurifyModulePromise = null;
}

export function getSanitizedHtmlPromise(code: string): Promise<string> {
  const cacheKey = createHtmlArtifactCacheKey(code);
  const cachedPromise = sanitizePromiseCache.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }

  const promise = getDomPurifyModulePromise()
    .then((purify) => purify.sanitize(code, SANITIZE_CONFIG))
    .then((html) => {
      cacheSanitizedHtml(cacheKey, html, code);
      return html;
    })
    .finally(() => {
      // Drop the settled promise so it is not pinned here forever; the LRU
      // (sanitizedHtmlCache) is the durable memo. Cache-first lookups serve
      // re-renders, an eviction correctly triggers a fresh sanitize, and a
      // failed sanitize is likewise freed for retry.
      sanitizePromiseCache.delete(cacheKey);
    });
  sanitizePromiseCache.set(cacheKey, promise);
  return promise;
}
