import { beforeEach, describe, expect, it, vi } from "vitest";

const sanitizeMock = vi.fn();

vi.mock("dompurify", () => ({
  default: {
    sanitize: sanitizeMock,
  },
}));

import {
  createHtmlArtifactCacheKey,
  getCachedSanitizedHtml,
  getSanitizedHtmlPromise,
  resetHtmlArtifactModuleForTests,
} from "./htmlArtifactRendering";

describe("htmlArtifactRendering", () => {
  beforeEach(() => {
    sanitizeMock.mockReset();
    resetHtmlArtifactModuleForTests();
  });

  it("cache key is stable for identical input and varies by content", () => {
    const a = createHtmlArtifactCacheKey("<button>a</button>");
    const b = createHtmlArtifactCacheKey("<button>a</button>");
    const c = createHtmlArtifactCacheKey("<button>b</button>");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("sanitizes with a script-free, no-framing policy and caches the result", async () => {
    const dirty = "<button>safe</button><script>evil()</script>";
    sanitizeMock.mockReturnValue("<button>safe</button>");

    const html = await getSanitizedHtmlPromise(dirty);

    expect(html).toBe("<button>safe</button>");
    expect(sanitizeMock).toHaveBeenCalledWith(
      dirty,
      expect.objectContaining({
        FORBID_TAGS: expect.arrayContaining(["script", "iframe", "object", "embed", "form"]),
      }),
    );
    expect(getCachedSanitizedHtml(createHtmlArtifactCacheKey(dirty))).toBe("<button>safe</button>");
  });

  it("dedupes concurrent sanitize calls for identical input", async () => {
    sanitizeMock.mockReturnValue("<span>x</span>");

    await Promise.all([
      getSanitizedHtmlPromise("<span>x</span>"),
      getSanitizedHtmlPromise("<span>x</span>"),
    ]);

    expect(sanitizeMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache when sanitize throws and frees the input for a later retry", async () => {
    sanitizeMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(getSanitizedHtmlPromise("<i>y</i>")).rejects.toThrow("boom");
    expect(getCachedSanitizedHtml(createHtmlArtifactCacheKey("<i>y</i>"))).toBeNull();

    sanitizeMock.mockReturnValue("<i>y</i>");
    expect(await getSanitizedHtmlPromise("<i>y</i>")).toBe("<i>y</i>");
  });
});
