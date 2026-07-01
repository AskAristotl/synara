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
