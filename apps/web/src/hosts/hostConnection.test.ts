import { afterEach, describe, expect, it, vi } from "vitest";

import type { Host } from "./hostStore";
import { makeHostConnection, RevokedHostCredentialError } from "./hostConnection";
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

  it("throws RevokedHostCredentialError on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );
    const conn = makeHostConnection(remoteHost, { credentials: creds("BEARER123") });
    await expect(conn.requestAuthJson("/api/auth/session")).rejects.toThrow(/re-?pair/i);
    await expect(conn.requestAuthJson("/api/auth/session")).rejects.toBeInstanceOf(
      RevokedHostCredentialError,
    );
  });

  it("aborts auth requests that hang past the timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );
      const conn = makeHostConnection(remoteHost, { credentials: creds("BEARER123") });
      const pending = conn.requestAuthJson("/api/auth/session");
      const assertion = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
