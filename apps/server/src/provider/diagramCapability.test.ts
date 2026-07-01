import { describe, expect, it } from "vitest";

import { MERMAID_CAPABILITY_INSTRUCTION, diagramCapabilityPreambleFor } from "./diagramCapability";

describe("diagramCapability", () => {
  it("instruction mentions the mermaid fence", () => {
    expect(MERMAID_CAPABILITY_INSTRUCTION.toLowerCase()).toContain("mermaid");
  });

  it("returns the preamble for a no-system-channel provider on the first turn", () => {
    expect(diagramCapabilityPreambleFor("cursor", true)).toBe(MERMAID_CAPABILITY_INSTRUCTION);
    expect(diagramCapabilityPreambleFor("pi", true)).toBe(MERMAID_CAPABILITY_INSTRUCTION);
  });

  it("returns nothing after the first turn", () => {
    expect(diagramCapabilityPreambleFor("cursor", false)).toBe("");
  });

  it("returns nothing for providers advertised via their system channel", () => {
    expect(diagramCapabilityPreambleFor("codex", true)).toBe("");
    expect(diagramCapabilityPreambleFor("claudeAgent", true)).toBe("");
  });
});
