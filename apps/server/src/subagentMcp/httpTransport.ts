/**
 * httpTransport - HTTP transport for the sub-agent MCP server.
 *
 * Mounts a single `POST` route that every provider session's MCP client
 * connects to. Auth is a per-session bearer token minted by
 * `SessionTokenRegistry.issueToken` at session start (see
 * docs/superpowers/specs/2026-06-30-cross-model-agents-design.md §3.2/§3.7):
 * the token resolves to the caller's identity server-side — the caller never
 * supplies its own `threadId` directly, so it can only ever act as the thread
 * it was issued for.
 *
 * This module is intentionally thin: all MCP protocol logic (JSON-RPC
 * dispatch, tool definitions, tool-call handling) lives in the
 * transport-agnostic `SubAgentMcpServer`. This file only extracts the bearer
 * token, resolves it to a caller identity, reads the JSON body, and maps the
 * handler's `Option<JsonRpcResponse>` onto an HTTP response.
 *
 * @module httpTransport
 */
import { Effect, Exit, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { jsonRpcParseError, SubAgentMcpServer } from "./SubAgentMcpServer.ts";
import { SessionTokenRegistry } from "./SessionTokenRegistry.ts";

/** Route path every provider session's MCP client is configured to POST to. */
export const SUBAGENT_MCP_ROUTE_PATH = "/internal/subagent-mcp";

const AUTHORIZATION_PREFIX = "Bearer ";

/** Extract the bearer token from `Authorization: Bearer <token>`, or `null` if absent/malformed. */
export function extractBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export const subAgentMcpRouteLayer = HttpRouter.add(
  "POST",
  SUBAGENT_MCP_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    const token = extractBearerToken(request);
    if (!token) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const tokens = yield* SessionTokenRegistry;
    const callerOption = yield* tokens.resolve(token);
    if (Option.isNone(callerOption)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    // Parse the body ourselves (rather than letting a decode failure crash the
    // route) so a malformed body maps to a JSON-RPC parse error instead of a
    // generic 500 — MCP clients expect a JSON-RPC envelope back, even on parse
    // failure.
    const bodyExit = yield* Effect.exit(request.json);
    if (Exit.isFailure(bodyExit)) {
      return HttpServerResponse.jsonUnsafe(jsonRpcParseError("Parse error: invalid JSON body."), {
        status: 200,
      });
    }

    const mcpServer = yield* SubAgentMcpServer;
    const responseOption = yield* mcpServer.handle(callerOption.value, bodyExit.value);
    return Option.match(responseOption, {
      // A JSON-RPC notification has no response; 202 Accepted with an empty
      // body signals "received, nothing to send back" without implying a
      // JSON-RPC result was produced.
      onNone: () => HttpServerResponse.empty({ status: 202 }),
      onSome: (response) => HttpServerResponse.jsonUnsafe(response, { status: 200 }),
    });
  }),
);
