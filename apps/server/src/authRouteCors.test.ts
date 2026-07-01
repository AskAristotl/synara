// Integration test for the production `/api/auth/*` Effect-based route.
// Boots the same `authEffectRouteLayer` that `makeEffectHttpRouteLayer` wires
// into `effectServer.ts` and exercises it through a real HTTP listener, the
// same way `localImageRoute.test.ts` covers `localImageEffectRouteLayer`.
//
// `http.test.ts` only exercises `serveAuthHttpRoute` (auth/http.ts), the
// legacy `http.RequestListener` path. This file guards the production
// effect-router path (`authEffectRouteLayer` in http.ts) so the two CORS/
// OPTIONS implementations cannot silently drift apart.
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "./auth/Services/SessionCredentialService";
import { resolveDefaultChatWorkspaceRoot, ServerConfig, type ServerConfigShape } from "./config";
import { authEffectRouteLayer } from "./http";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeServerConfig(overrides: Partial<ServerConfigShape> = {}): ServerConfigShape {
  const baseDir = makeTempDir("dpcode-auth-route-cors-");
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    keybindingsConfigPath: path.join(baseDir, "keybindings.json"),
    serverRuntimeStatePath: path.join(baseDir, "runtime.json"),
    serverSettingsPath: path.join(baseDir, "settings.json"),
    attachmentsDir: path.join(baseDir, "attachments"),
    sqlitePath: path.join(baseDir, "state.sqlite"),
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  } as ServerConfigShape;
}

function makeFakeServerAuth(): ServerAuthShape {
  const descriptor = {
    policy: "loopback-browser" as const,
    bootstrapMethods: ["one-time-token" as const],
    sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
    sessionCookieName: "t3_session",
  };
  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: () => Effect.succeed({ authenticated: false, auth: descriptor }),
    exchangeBootstrapCredential: () => Effect.die("unused"),
    exchangeBootstrapCredentialForBearerSession: () => Effect.die("unused"),
    issuePairingCredential: () => Effect.die("unused"),
    listPairingLinks: () => Effect.die("unused"),
    revokePairingLink: () => Effect.die("unused"),
    listClientSessions: () => Effect.die("unused"),
    revokeClientSession: () => Effect.die("unused"),
    revokeOtherClientSessions: () => Effect.die("unused"),
    authenticateHttpRequest: () => Effect.die("unused"),
    authenticateWebSocketUpgrade: () => Effect.die("unused"),
    issueWebSocketToken: () => Effect.die("unused"),
    issueStartupPairingUrl: () => Effect.die("unused"),
    issueClientPairingUrl: () => Effect.die("unused"),
  } satisfies ServerAuthShape;
}

// `authRouteEffect` (the inner handler authEffectRouteLayer delegates to)
// resolves SessionCredentialService unconditionally before branching on the
// route, even though only the bootstrap branch reads from it. None of the
// routes covered here exercise it, so every method besides `cookieName` is a
// stub that fails loudly if it's ever actually invoked.
function makeFakeSessionCredentialService(): SessionCredentialServiceShape {
  return {
    cookieName: "t3_session",
    issue: () => Effect.die("unused"),
    verify: () => Effect.die("unused"),
    issueWebSocketToken: () => Effect.die("unused"),
    verifyWebSocketToken: () => Effect.die("unused"),
    listActive: () => Effect.die("unused"),
    streamChanges: Stream.empty,
    revoke: () => Effect.die("unused"),
    revokeAllExcept: () => Effect.die("unused"),
    markConnected: () => Effect.void,
    markDisconnected: () => Effect.void,
  } satisfies SessionCredentialServiceShape;
}

async function withAuthEffectServer(
  config: ServerConfigShape,
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
          const httpApp = yield* HttpRouter.toHttpEffect(authEffectRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, config),
              Layer.succeed(ServerAuth, makeFakeServerAuth()),
              Layer.succeed(SessionCredentialService, makeFakeSessionCredentialService()),
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
    const origin = `http://127.0.0.1:${address.port}`;
    await run(origin);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("authEffectRouteLayer", () => {
  it("answers OPTIONS preflight on /api/auth/session with CORS headers for t3://app", async () => {
    const config = makeServerConfig();

    await withAuthEffectServer(config, async (origin) => {
      const response = await fetch(`${origin}/api/auth/session`, {
        method: "OPTIONS",
        headers: { Origin: "t3://app" },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("t3://app");
      expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    });
  });

  it("includes CORS headers on GET /api/auth/session for t3://app", async () => {
    const config = makeServerConfig();

    await withAuthEffectServer(config, async (origin) => {
      const response = await fetch(`${origin}/api/auth/session`, {
        headers: { Origin: "t3://app" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("t3://app");
    });
  });

  it("omits Access-Control-Allow-Origin for same-origin/no-Origin requests", async () => {
    const config = makeServerConfig();

    await withAuthEffectServer(config, async (origin) => {
      const response = await fetch(`${origin}/api/auth/session`);

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
