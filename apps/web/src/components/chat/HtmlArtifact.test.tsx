import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const getCachedSanitizedHtmlMock = vi.fn();
const getSanitizedHtmlPromiseMock = vi.fn();

vi.mock("../../lib/htmlArtifactRendering", () => ({
  createHtmlArtifactCacheKey: () => "key",
  getCachedSanitizedHtml: getCachedSanitizedHtmlMock,
  getSanitizedHtmlPromise: getSanitizedHtmlPromiseMock,
}));

async function render(props: { isStreaming: boolean; cachedHtml: string | null }) {
  getCachedSanitizedHtmlMock.mockReturnValue(props.cachedHtml);
  getSanitizedHtmlPromiseMock.mockReturnValue(new Promise<string>(() => {}));
  const { default: HtmlArtifact } = await import("./HtmlArtifact");
  return renderToStaticMarkup(
    <HtmlArtifact
      code="<button>Hi</button>"
      isStreaming={props.isStreaming}
      sourceFallback={<pre>SOURCE_BLOCK</pre>}
    />,
  );
}

describe("HtmlArtifact", () => {
  it("renders the source block while streaming", async () => {
    const markup = await render({ isStreaming: true, cachedHtml: "<button>Hi</button>" });
    expect(markup).toContain("SOURCE_BLOCK");
    expect(markup).not.toContain("chat-markdown-html-artifact");
  });

  it("renders the artifact frame when a sanitized result is cached", async () => {
    const markup = await render({ isStreaming: false, cachedHtml: "<button>Hi</button>" });
    expect(markup).toContain("chat-markdown-html-artifact");
    expect(markup).not.toContain("SOURCE_BLOCK");
  });

  it("falls back to the source block while an uncached sanitize is pending", async () => {
    const markup = await render({ isStreaming: false, cachedHtml: null });
    expect(markup).toContain("SOURCE_BLOCK");
    expect(markup).not.toContain("chat-markdown-html-artifact");
  });
});
