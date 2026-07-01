import { describe, expect, it } from "vitest";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../codexAppServerManager";
import { EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND } from "./Layers/ClaudeAdapter";
import { MERMAID_CAPABILITY_INSTRUCTION } from "./diagramCapability";

describe("diagramCapability wiring", () => {
  it("advertises the diagram capability in both Codex developer instruction modes", () => {
    expect(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS).toContain(MERMAID_CAPABILITY_INSTRUCTION);
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain(MERMAID_CAPABILITY_INSTRUCTION);
  });

  it("advertises the diagram capability in the Claude system prompt append", () => {
    expect(EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND).toContain(MERMAID_CAPABILITY_INSTRUCTION);
  });
});
