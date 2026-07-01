// FILE: MermaidDiagram.tsx
// Purpose: Render a ```mermaid fenced block inline — lazy-loaded, cache-first, render-on-complete,
//          with an error/streaming fallback to the source block plus copy + expand affordances.
// Layer: Web chat presentation component
// Exports: MermaidDiagram (default)

import { type MouseEvent, Suspense, use, useCallback, type ReactNode } from "react";

import { CheckIcon, CopyIcon, Maximize2 } from "~/lib/icons";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  createMermaidCacheKey,
  getCachedMermaidSvg,
  getMermaidSvgPromise,
  resolveMermaidTheme,
  type MermaidTheme,
} from "../../lib/mermaidRendering";
import { IconButton } from "../ui/icon-button";
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
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1200 });

  const handleCopy = useCallback(() => copyToClipboard(code), [copyToClipboard, code]);

  const handleExpand = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      onImageExpand?.({
        images: [
          { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, name: "Diagram" },
        ],
        index: 0,
      });
    },
    [onImageExpand, svg],
  );

  return (
    <div className="chat-markdown-mermaid" data-diagram="true">
      <div className="chat-markdown-mermaid__actions">
        {onImageExpand ? (
          <IconButton
            className="chat-markdown-mermaid__action"
            onClick={handleExpand}
            title="Expand diagram"
            label="Expand diagram"
            size="icon-xs"
            variant="ghost"
          >
            <Maximize2 className="size-3" />
          </IconButton>
        ) : null}
        <IconButton
          className="chat-markdown-mermaid__action"
          onClick={handleCopy}
          title={isCopied ? "Copied" : "Copy diagram source"}
          label={isCopied ? "Copied" : "Copy diagram source"}
          size="icon-xs"
          variant="ghost"
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </IconButton>
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
