import { describe, expect, it } from "vitest";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../codexAppServerManager";
import { EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND } from "./Layers/ClaudeAdapter";
import {
  HTML_PREVIEW_CAPABILITY_INSTRUCTION,
  MERMAID_CAPABILITY_INSTRUCTION,
} from "./diagramCapability";

describe("renderableCapabilities wiring", () => {
  it("advertises both render capabilities in both Codex developer instruction modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      expect(instructions).toContain(MERMAID_CAPABILITY_INSTRUCTION);
      expect(instructions).toContain(HTML_PREVIEW_CAPABILITY_INSTRUCTION);
    }
  });

  it("advertises both render capabilities in the Claude system prompt append", () => {
    expect(EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND).toContain(MERMAID_CAPABILITY_INSTRUCTION);
    expect(EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND).toContain(HTML_PREVIEW_CAPABILITY_INSTRUCTION);
  });
});
