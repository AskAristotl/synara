// apps/web/src/hosts/pairing.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Node has no global `localStorage`, and zustand's `createJSONStorage` resolves
// its storage getter eagerly at module-import time (see hostStore.test.ts /
// workspaceStore.test.ts for the same pattern). Stub a working in-memory
// localStorage once, then dynamically import the store + module under test so
// they capture it.
let useHostStore: typeof import("./hostStore").useHostStore;
let parsePairingLink: typeof import("./pairing").parsePairingLink;
let redeemPairingLink: typeof import("./pairing").redeemPairingLink;

beforeAll(async () => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    clear: vi.fn(() => {
      entries.clear();
    }),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    get length() {
      return entries.size;
    },
  });
  ({ useHostStore } = await import("./hostStore"));
  ({ parsePairingLink, redeemPairingLink } = await import("./pairing"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  useHostStore.setState(useHostStore.getInitialState(), true);
});
afterEach(() => vi.restoreAllMocks());

describe("parsePairingLink", () => {
  it("extracts origin + token from a /pair#token= link", () => {
    expect(parsePairingLink("https://studio.ts.net:3773/pair#token=ABCD1234WXYZ")).toEqual({
      baseUrl: "https://studio.ts.net:3773",
      credential: "ABCD1234WXYZ",
    });
  });
  it("returns null for a link without a token", () => {
    expect(parsePairingLink("https://studio.ts.net:3773/pair")).toBeNull();
  });
  it("returns null for non-URL input", () => {
    expect(parsePairingLink("not a link")).toBeNull();
  });
});

describe("redeemPairingLink", () => {
  it("redeems, stores the bearer, and adds the host", async () => {
    const credStore = { stored: new Map<string, string>() };
    const credentials = {
      get: async (id: string) => credStore.stored.get(id) ?? null,
      set: async (id: string, v: string) => void credStore.stored.set(id, v),
      delete: async (id: string) => void credStore.stored.delete(id),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          role: "client",
          sessionMethod: "bearer-session-token",
          expiresAt: "2030-01-01T00:00:00Z",
          sessionToken: "BEARER_TOKEN",
        }),
        { status: 200 },
      ),
    );
    const host = await redeemPairingLink("https://studio.ts.net:3773/pair#token=ABCD1234WXYZ", {
      credentials,
      label: "Mac Studio",
    });
    expect(host.kind).toBe("remote");
    expect(host.baseUrl).toBe("https://studio.ts.net:3773");
    expect(credStore.stored.get(host.id)).toBe("BEARER_TOKEN");
    expect(useHostStore.getState().hosts.some((h) => h.id === host.id)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://studio.ts.net:3773/api/auth/bootstrap/bearer",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "ABCD1234WXYZ" }),
      }),
    );
  });
});
