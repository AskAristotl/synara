// FILE: sharedBrainMcp.ts
// Purpose: Mount the ONE shared gbrain brain as an MCP server for coding
//   agents, config-only via GBRAIN_MCP_URL — no other memory store.
// Layer: Provider utility shared by provider adapters (Claude today; codex /
//   cursor can reuse this same builder when they mount it).
// Exports: sharedBrainMcpServers — env-driven { gbrain: httpServer } | {}.

/** HTTP MCP server config shape (matches the claude-agent-sdk mcpServers entry). */
export interface BrainMcpHttpServer {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Record<string, string>;
}

const SERVER_KEY = "gbrain";

/**
 * Build the shared-brain mcpServers entry from env. Returns {} when
 * GBRAIN_MCP_URL is unset, so callers spread it into their mcpServers map and
 * the brain is simply absent (everything else unaffected). GBRAIN_MCP_TOKEN,
 * when set, rides as a Bearer header (the daemon's scope-gated auth); a local
 * no-auth daemon needs none.
 *
 * The gbrain daemon is the ONE shared studio brain — a single `gbrain serve
 * --http` daemon that solely owns the PGLite store; every consumer reaches it
 * over HTTP. Setup + pin: the tag repo's docs/dev/orchestrator-runbook.md.
 */
export function sharedBrainMcpServers(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, BrainMcpHttpServer> {
  const url = env.GBRAIN_MCP_URL?.trim();
  if (!url) {
    return {};
  }
  const token = env.GBRAIN_MCP_TOKEN?.trim();
  return {
    [SERVER_KEY]: {
      type: "http",
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  };
}
