// FILE: HtmlArtifact.tsx
// Purpose: Render a ```html-preview fenced block inline — lazy-sanitized (DOMPurify),
//          cache-first, rendered on complete into a style-isolated shadow root, with an
//          error/streaming fallback to the source block plus a copy affordance.
// Layer: Web chat presentation component
// Exports: HtmlArtifact (default)

import { Suspense, use, useCallback, useEffect, useRef, type ReactNode } from "react";

import { CheckIcon, CopyIcon } from "~/lib/icons";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  createHtmlArtifactCacheKey,
  getCachedSanitizedHtml,
  getSanitizedHtmlPromise,
} from "../../lib/htmlArtifactRendering";
import { IconButton } from "../ui/icon-button";
import { CodeHighlightErrorBoundary } from "./CodeHighlightErrorBoundary";

interface HtmlArtifactProps {
  code: string;
  isStreaming: boolean;
  sourceFallback: ReactNode;
}

function HtmlArtifactFrame({ html, code }: { html: string; code: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1200 });
  const handleCopy = useCallback(() => copyToClipboard(code), [copyToClipboard, code]);

  // Render into a shadow root so the artifact's own <style> (including :hover and
  // @keyframes) is scoped to the preview and cannot leak into — or inherit from —
  // the surrounding app. innerHTML never executes <script>, and the string is
  // already DOMPurify-sanitized, so no code runs regardless.
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = html;
  }, [html]);

  return (
    <div className="chat-markdown-html-artifact" data-artifact="true">
      <div className="chat-markdown-html-artifact__actions">
        <IconButton
          className="chat-markdown-html-artifact__action"
          onClick={handleCopy}
          title={isCopied ? "Copied" : "Copy HTML source"}
          label={isCopied ? "Copied" : "Copy HTML source"}
          size="icon-xs"
          variant="ghost"
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </IconButton>
      </div>
      <div className="chat-markdown-html-artifact__content" ref={hostRef} />
    </div>
  );
}

function SuspendedHtmlArtifactFrame({ code }: { code: string }) {
  const html = use(getSanitizedHtmlPromise(code));
  return <HtmlArtifactFrame html={html} code={code} />;
}

export default function HtmlArtifact({ code, isStreaming, sourceFallback }: HtmlArtifactProps) {
  // Partial HTML mid-stream renders as broken/janky markup; show the source until the
  // block settles, mirroring the mermaid renderer.
  if (isStreaming) {
    return <>{sourceFallback}</>;
  }

  const cachedHtml = getCachedSanitizedHtml(createHtmlArtifactCacheKey(code));
  if (cachedHtml != null) {
    return <HtmlArtifactFrame html={cachedHtml} code={code} />;
  }

  return (
    <CodeHighlightErrorBoundary fallback={sourceFallback}>
      <Suspense fallback={sourceFallback}>
        <SuspendedHtmlArtifactFrame code={code} />
      </Suspense>
    </CodeHighlightErrorBoundary>
  );
}
