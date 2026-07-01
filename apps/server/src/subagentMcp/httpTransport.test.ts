// Integration test for the sub-agent MCP HTTP transport. Boots the real
// `subAgentMcpRouteLayer` (the same layer `http.ts` wires into
// `makeEffectHttpRouteLayer`) behind a real HTTP listener, mirroring the
// pattern in `localImageRoute.test.ts`. `SessionTokenRegistry` and
// `SubAgentMcpServer` are provided as test doubles so this stays focused on
// the transport's own job: bearer-token auth, JSON body parsing, and mapping
// the handler's `Option<JsonRpcResponse>` onto an HTTP response.
import http from "node:http";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  SessionTokenRegistry,
  type SessionTokenIdentity,
  type SessionTokenRegistryShape,
} from "./SessionTokenRegistry.ts";
import { SubAgentMcpServer, type SubAgentMcpServerShape } from "./SubAgentMcpServer.ts";
import { extractBearerToken, subAgentMcpRouteLayer } from "./httpTransport.ts";

const CALLER = {
  threadId: ThreadId.makeUnsafe("caller-thread"),
  canSpawn: true,
} satisfies SessionTokenIdentity;
const VALID_TOKEN = "a-valid-bearer-token";

function makeFakeTokenRegistry(): SessionTokenRegistryShape {
  return {
    issueToken: () => Effect.die(new Error("issueToken unused in transport test")),
    resolve: (token) => Effect.succeed(token === VALID_TOKEN ? Option.some(CALLER) : Option.none()),
    revoke: () => Effect.die(new Error("revoke unused in transport test")),
  };
}

function makeFakeMcpServer(handle: SubAgentMcpServerShape["handle"]): SubAgentMcpServerShape {
  return { handle };
}

async function withRunningTransport(
  services: {
    readonly tokens: SessionTokenRegistryShape;
    readonly mcpServer: SubAgentMcpServerShape;
  },
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(subAgentMcpRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(SessionTokenRegistry, services.tokens),
              Layer.succeed(SubAgentMcpServer, services.mcpServer),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected effect server to expose an address");
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed Authorization header", () => {
    const request = {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    } as unknown as Parameters<typeof extractBearerToken>[0];
    expect(extractBearerToken(request)).toBe(VALID_TOKEN);
  });

  it("returns null when the Authorization header is missing", () => {
    const request = { headers: {} } as unknown as Parameters<typeof extractBearerToken>[0];
    expect(extractBearerToken(request)).toBeNull();
  });

  it("returns null for a non-Bearer Authorization scheme", () => {
    const request = { headers: { authorization: "Basic dXNlcjpwYXNz" } } as unknown as Parameters<
      typeof extractBearerToken
    >[0];
    expect(extractBearerToken(request)).toBeNull();
  });

  it("returns null for an empty Bearer token", () => {
    const request = { headers: { authorization: "Bearer    " } } as unknown as Parameters<
      typeof extractBearerToken
    >[0];
    expect(extractBearerToken(request)).toBeNull();
  });
});

describe("subAgentMcpRouteLayer", () => {
  afterEach(() => {
    // No shared state between tests, but keep the hook present in case a
    // future test needs teardown (mirrors the sibling route test files).
  });

  it("rejects a request with no Authorization header", async () => {
    const tokens = makeFakeTokenRegistry();
    const mcpServer = makeFakeMcpServer(() =>
      Effect.die(new Error("handle unused for unauth request")),
    );

    await withRunningTransport({ tokens, mcpServer }, async (origin) => {
      const response = await fetch(origin + "/internal/subagent-mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(401);
    });
  });

  it("rejects a request bearing an unknown/invalid token", async () => {
    const tokens = makeFakeTokenRegistry();
    const mcpServer = makeFakeMcpServer(() =>
      Effect.die(new Error("handle unused for unauth request")),
    );

    await withRunningTransport({ tokens, mcpServer }, async (origin) => {
      const response = await fetch(origin + "/internal/subagent-mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(401);
    });
  });

  it("round-trips a tools/call for a request bearing a valid token", async () => {
    const tokens = makeFakeTokenRegistry();
    const receivedCalls: Array<{ caller: SessionTokenIdentity; message: unknown }> = [];
    const mcpServer = makeFakeMcpServer((caller, message) => {
      receivedCalls.push({ caller, message });
      return Effect.succeed(Option.some({ jsonrpc: "2.0" as const, id: 1, result: { tools: [] } }));
    });

    await withRunningTransport({ tokens, mcpServer }, async (origin) => {
      const requestBody = { jsonrpc: "2.0", id: 1, method: "tools/list" };
      const response = await fetch(origin + "/internal/subagent-mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify(requestBody),
      });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
      expect(receivedCalls).toHaveLength(1);
      expect(receivedCalls[0]!.caller).toEqual(CALLER);
      expect(receivedCalls[0]!.message).toEqual(requestBody);
    });
  });

  it("responds 202 with no body for a JSON-RPC notification (handler returns Option.none())", async () => {
    const tokens = makeFakeTokenRegistry();
    const mcpServer = makeFakeMcpServer(() => Effect.succeed(Option.none()));

    await withRunningTransport({ tokens, mcpServer }, async (origin) => {
      const response = await fetch(origin + "/internal/subagent-mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      expect(response.status).toBe(202);
      const text = await response.text();
      expect(text).toBe("");
    });
  });

  it("returns a JSON-RPC parse-error envelope for a malformed JSON body", async () => {
    const tokens = makeFakeTokenRegistry();
    const mcpServer = makeFakeMcpServer(() =>
      Effect.die(new Error("handle unused for a body parse failure")),
    );

    await withRunningTransport({ tokens, mcpServer }, async (origin) => {
      const response = await fetch(origin + "/internal/subagent-mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${VALID_TOKEN}` },
        body: "{not valid json",
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        jsonrpc: string;
        id: unknown;
        error?: { code: number };
      };
      expect(json.jsonrpc).toBe("2.0");
      expect(json.id).toBeNull();
      expect(json.error?.code).toBe(-32700);
    });
  });
});
