import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
const parseMock = vi.fn();
const initializeMock = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMock,
    parse: parseMock,
    render: renderMock,
  },
}));

import {
  createMermaidCacheKey,
  getCachedMermaidSvg,
  getMermaidModulePromise,
  getMermaidSvgPromise,
  resetMermaidModuleForTests,
  resolveMermaidTheme,
} from "./mermaidRendering";

describe("mermaidRendering", () => {
  beforeEach(() => {
    renderMock.mockReset();
    parseMock.mockReset();
    initializeMock.mockReset();
    resetMermaidModuleForTests();
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

  it("retries module load after a transient init failure instead of staying wedged", async () => {
    initializeMock.mockImplementationOnce(() => {
      throw new Error("init failed");
    });

    await expect(getMermaidModulePromise()).rejects.toThrow("init failed");

    const mermaid = await getMermaidModulePromise();

    expect(mermaid.initialize).toHaveBeenCalledTimes(2);
  });
});
