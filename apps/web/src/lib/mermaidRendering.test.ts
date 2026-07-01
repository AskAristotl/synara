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

  it("does not retry render when parse fails (syntax errors are deterministic)", async () => {
    parseMock.mockRejectedValue(new Error("parse error"));

    await expect(getMermaidSvgPromise("not a diagram", "default")).rejects.toThrow("parse error");
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("retries a transient render failure and then resolves without re-parsing", async () => {
    parseMock.mockResolvedValue(true);
    renderMock
      .mockRejectedValueOnce(new Error("transient render race"))
      .mockResolvedValueOnce({ svg: "<svg>recovered</svg>" });

    const svg = await getMermaidSvgPromise("graph TD;A-->B", "default");

    expect(svg).toBe("<svg>recovered</svg>");
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting render attempts", async () => {
    parseMock.mockResolvedValue(true);
    renderMock.mockRejectedValue(new Error("still broken"));

    await expect(getMermaidSvgPromise("graph TD;A-->B", "default")).rejects.toThrow("still broken");
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(3);
  });

  it("repairs a diagram whose label starts with backticks and renders it", async () => {
    const code = 'flowchart LR\n  A["```fence"] --> B["x"]';
    // Original (backtick) source fails to parse; the escaped copy parses.
    parseMock.mockImplementation((text: string) =>
      text.includes("`") ? Promise.reject(new Error("Lexical error")) : Promise.resolve(true),
    );
    renderMock.mockResolvedValue({ svg: "<svg>repaired</svg>" });

    const svg = await getMermaidSvgPromise(code, "default");

    expect(svg).toBe("<svg>repaired</svg>");
    const renderedSource = renderMock.mock.calls.at(-1)?.[1] as string;
    expect(renderedSource).toContain("&#96;");
    expect(renderedSource).not.toContain("`");
  });

  it("does not rewrite a diagram that already parses even if it has backticks", async () => {
    const code = 'flowchart LR\n  A["`bold`"] --> B["x"]';
    parseMock.mockResolvedValue(true);
    renderMock.mockResolvedValue({ svg: "<svg>ok</svg>" });

    await getMermaidSvgPromise(code, "default");

    const renderedSource = renderMock.mock.calls.at(-1)?.[1] as string;
    expect(renderedSource).toContain("`");
    expect(renderedSource).not.toContain("&#96;");
  });

  it("surfaces the original parse error when the backtick repair also fails", async () => {
    const code = 'flowchart LR\n  A["```x"] --> B[';
    parseMock.mockImplementation((text: string) =>
      Promise.reject(new Error(text.includes("&#96;") ? "repaired error" : "original error")),
    );

    await expect(getMermaidSvgPromise(code, "default")).rejects.toThrow("original error");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("serializes concurrent diagrams so parse+render never overlap", async () => {
    parseMock.mockResolvedValue(true);
    let active = 0;
    let maxActive = 0;
    renderMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { svg: "<svg>ok</svg>" };
    });

    await Promise.all([
      getMermaidSvgPromise("graph TD;A-->B", "default"),
      getMermaidSvgPromise("graph TD;C-->D", "default"),
      getMermaidSvgPromise("graph TD;E-->F", "default"),
    ]);

    expect(maxActive).toBe(1);
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
