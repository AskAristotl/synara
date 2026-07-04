// FILE: sharedBrainMcp.test.ts
// Purpose: Config-only wiring of the shared gbrain brain MCP server.
// Layer: Provider utility tests.
// Exports: Vitest coverage for apps/server/src/provider/sharedBrainMcp.ts.
import { assert, describe, it } from "@effect/vitest";

import { sharedBrainMcpServers } from "./sharedBrainMcp.ts";

describe("sharedBrainMcpServers", () => {
  it("returns {} when GBRAIN_MCP_URL is unset — brain not mounted", () => {
    assert.deepStrictEqual(sharedBrainMcpServers({}), {});
    assert.deepStrictEqual(sharedBrainMcpServers({ GBRAIN_MCP_URL: "   " }), {});
    // a token without a url is still not mounted
    assert.deepStrictEqual(sharedBrainMcpServers({ GBRAIN_MCP_TOKEN: "t" }), {});
  });

  it("mounts a single http gbrain server at the url (no token)", () => {
    assert.deepStrictEqual(sharedBrainMcpServers({ GBRAIN_MCP_URL: "http://127.0.0.1:3131/mcp" }), {
      gbrain: { type: "http", url: "http://127.0.0.1:3131/mcp" },
    });
  });

  it("carries a Bearer Authorization header when GBRAIN_MCP_TOKEN is set", () => {
    assert.deepStrictEqual(
      sharedBrainMcpServers({
        GBRAIN_MCP_URL: "http://x/mcp",
        GBRAIN_MCP_TOKEN: "gbrain_secret",
      }),
      {
        gbrain: {
          type: "http",
          url: "http://x/mcp",
          headers: { Authorization: "Bearer gbrain_secret" },
        },
      },
    );
  });
});
