// apps/web/src/hosts/hostCredentialStore.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Node has no global `window`/`localStorage`. Stub a minimal `window` and an
// in-memory `localStorage` once, then dynamically import the module under
// test so it resolves `window.desktopBridge` against the stub (see
// hostStore.test.ts / workspaceStore.test.ts for the same pattern).
let getHostCredentialStore: typeof import("./hostCredentialStore").getHostCredentialStore;

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
  });
  vi.stubGlobal("window", {});
  ({ getHostCredentialStore } = await import("./hostCredentialStore"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  // Ensure no desktop bridge in this environment so the localStorage path is exercised.
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

describe("hostCredentialStore (localStorage fallback)", () => {
  it("round-trips a credential", async () => {
    const store = getHostCredentialStore();
    await store.set("host_1", "SECRETTOKEN");
    expect(await store.get("host_1")).toBe("SECRETTOKEN");
  });

  it("returns null for an unknown host", async () => {
    expect(await getHostCredentialStore().get("nope")).toBeNull();
  });

  it("deletes a credential", async () => {
    const store = getHostCredentialStore();
    await store.set("host_1", "X");
    await store.delete("host_1");
    expect(await store.get("host_1")).toBeNull();
  });
});
