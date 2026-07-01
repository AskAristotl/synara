import { describe, expect, it } from "vitest";

import {
  HTML_PREVIEW_CAPABILITY_INSTRUCTION,
  MERMAID_CAPABILITY_INSTRUCTION,
  RENDERABLE_CAPABILITIES_INSTRUCTION,
  renderableCapabilitiesPreambleFor,
} from "./diagramCapability";

describe("renderableCapabilities", () => {
  it("mermaid instruction mentions the mermaid fence", () => {
    expect(MERMAID_CAPABILITY_INSTRUCTION.toLowerCase()).toContain("mermaid");
  });

  it("html-preview instruction mentions the html-preview fence", () => {
    expect(HTML_PREVIEW_CAPABILITY_INSTRUCTION.toLowerCase()).toContain("html-preview");
  });

  it("combined instruction includes both capabilities", () => {
    expect(RENDERABLE_CAPABILITIES_INSTRUCTION).toContain(MERMAID_CAPABILITY_INSTRUCTION);
    expect(RENDERABLE_CAPABILITIES_INSTRUCTION).toContain(HTML_PREVIEW_CAPABILITY_INSTRUCTION);
  });

  it("returns the combined preamble for a no-system-channel provider on the first turn", () => {
    expect(renderableCapabilitiesPreambleFor("cursor", true)).toBe(
      RENDERABLE_CAPABILITIES_INSTRUCTION,
    );
    expect(renderableCapabilitiesPreambleFor("pi", true)).toBe(RENDERABLE_CAPABILITIES_INSTRUCTION);
  });

  it("returns nothing after the first turn", () => {
    expect(renderableCapabilitiesPreambleFor("cursor", false)).toBe("");
  });

  it("returns nothing for providers advertised via their system channel", () => {
    expect(renderableCapabilitiesPreambleFor("codex", true)).toBe("");
    expect(renderableCapabilitiesPreambleFor("claudeAgent", true)).toBe("");
  });
});
