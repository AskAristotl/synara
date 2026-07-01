/**
 * constants - Leaf-level constants for the sub-agent MCP transport.
 *
 * Kept dependency-free (no orchestration-adjacent imports) so callers outside
 * the sub-agent MCP module's own graph — notably `ProviderService`, which
 * must not pull orchestration-adjacent imports into the provider layer (see
 * the provider/orchestration layer boundary) — can depend on it without
 * dragging in `httpTransport.ts`'s wider import surface (`HttpRouter`,
 * `SessionTokenRegistry`, etc.).
 *
 * @module constants
 */

/** Route path every provider session's MCP client is configured to POST to. */
export const SUBAGENT_MCP_ROUTE_PATH = "/internal/subagent-mcp";
