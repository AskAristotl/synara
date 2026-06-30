// apps/web/src/routes/-pairRedeem.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Node has no global `localStorage`, and zustand's `createJSONStorage` resolves
// its storage getter eagerly at module-import time (see hostStore.test.ts /
// pairing.test.ts for the same pattern). Stub a working in-memory localStorage
// once, then dynamically import the store + module under test so they capture it.
let useHostStore: typeof import("../hosts/hostStore").useHostStore;
let pairRedeemFromLocation: typeof import("./-pairRedeem").pairRedeemFromLocation;

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
  ({ useHostStore } = await import("../hosts/hostStore"));
  ({ pairRedeemFromLocation } = await import("./-pairRedeem"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  useHostStore.setState(useHostStore.getInitialState(), true);
});
afterEach(() => vi.restoreAllMocks());

describe("pairRedeemFromLocation", () => {
  it("redeems the token from the current location hash and activates the host", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessionToken: "T", role: "client" }), { status: 200 }),
    );
    const result = await pairRedeemFromLocation(
      "https://studio.ts.net:3773/pair#token=ABCD1234WXYZ",
      {
        credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(useHostStore.getState().activeHostId).toBe(result.hostId);
    }
  });

  it("returns an error message for an invalid link", async () => {
    const result = await pairRedeemFromLocation("https://x/pair", {
      credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
    });
    expect(result.ok).toBe(false);
  });
});
