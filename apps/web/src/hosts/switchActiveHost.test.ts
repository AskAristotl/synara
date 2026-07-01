// apps/web/src/hosts/switchActiveHost.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `useHostStore` (zustand persist) resolves `localStorage` eagerly at
// module-import time, and Node has no global `localStorage`. Stub a working
// in-memory localStorage once, then dynamically import the modules under
// test so they capture it — mirrors hostStore.test.ts.
let useHostStore: typeof import("./hostStore").useHostStore;
let switchActiveHost: typeof import("./switchActiveHost").switchActiveHost;

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
  ({ switchActiveHost } = await import("./switchActiveHost"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  useHostStore.setState(useHostStore.getInitialState(), true);
});

describe("switchActiveHost", () => {
  it("persists the new active host id and reloads", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773" });
    const reload = vi.fn();
    switchActiveHost(host.id, { reload });
    expect(useHostStore.getState().activeHostId).toBe(host.id);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does nothing when switching to the already-active host", () => {
    const reload = vi.fn();
    switchActiveHost(useHostStore.getState().activeHostId, { reload });
    expect(reload).not.toHaveBeenCalled();
  });
});
