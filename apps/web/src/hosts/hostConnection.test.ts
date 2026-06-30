import { afterEach, describe, expect, it, vi } from "vitest";

import type { Host } from "./hostStore";
import { makeHostConnection } from "./hostConnection";
import type { HostCredentialStore } from "./hostCredentialStore";

const remoteHost: Host = {
  id: "host_1",
  label: "Studio",
  kind: "remote",
  baseUrl: "https://studio.ts.net:3773",
  createdAt: 0,
  lastConnectedAt: null,
};

const creds = (token: string | null): HostCredentialStore => ({
  get: async () => token,
  set: async () => {},
  delete: async () => {},
});

afterEach(() => vi.restoreAllMocks());

describe("makeHostConnection (remote)", () => {
  it("sends Authorization: Bearer with an absolute URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const conn = makeHostConnection(remoteHost, { credentials: creds("BEARER123") });
    await conn.requestAuthJson("/api/auth/session");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://studio.ts.net:3773/api/auth/session");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer BEARER123");
    expect(init?.credentials).toBe("omit");
  });

  it("resolves a wss /ws URL with a fresh wsToken", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "WS_TOKEN", expiresAt: "2030-01-01T00:00:00Z" }), {
        status: 200,
      }),
    );
    const conn = makeHostConnection(remoteHost, { credentials: creds("BEARER123") });
    const url = await conn.resolveSocketUrl();
    expect(url).toBe("wss://studio.ts.net:3773/ws?wsToken=WS_TOKEN");
  });

  it("throws a typed error when no credential is stored", async () => {
    const conn = makeHostConnection(remoteHost, { credentials: creds(null) });
    await expect(conn.requestAuthJson("/api/auth/session")).rejects.toThrow(/credential/i);
  });
});
