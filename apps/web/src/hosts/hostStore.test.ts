// apps/web/src/hosts/hostStore.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Node has no global `localStorage`, and zustand's `createJSONStorage` resolves
// its storage getter eagerly at module-import time (see workspaceStore.test.ts /
// singleChatPanelStore.test.ts for the same pattern). Stub a working in-memory
// localStorage once, then dynamically import the store so it captures it.
let LOCAL_HOST_ID: typeof import("./hostStore").LOCAL_HOST_ID;
let useHostStore: typeof import("./hostStore").useHostStore;

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
  ({ LOCAL_HOST_ID, useHostStore } = await import("./hostStore"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  useHostStore.persist.clearStorage();
  useHostStore.setState(useHostStore.getInitialState(), true);
});

describe("hostStore", () => {
  it("starts with the pinned local host active", () => {
    const state = useHostStore.getState();
    expect(state.hosts.some((h) => h.id === LOCAL_HOST_ID)).toBe(true);
    expect(state.activeHostId).toBe(LOCAL_HOST_ID);
  });

  it("adds a remote host and can activate it", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Mac Studio", baseUrl: "https://studio.ts.net:3773" });
    expect(host.kind).toBe("remote");
    useHostStore.getState().setActiveHostId(host.id);
    expect(useHostStore.getState().getActiveHost().label).toBe("Mac Studio");
  });

  it("refuses to remove the local host and falls back to local when removing the active host", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773" });
    useHostStore.getState().setActiveHostId(host.id);
    useHostStore.getState().removeHost(LOCAL_HOST_ID);
    expect(useHostStore.getState().hosts.some((h) => h.id === LOCAL_HOST_ID)).toBe(true);
    useHostStore.getState().removeHost(host.id);
    expect(useHostStore.getState().activeHostId).toBe(LOCAL_HOST_ID);
    expect(useHostStore.getState().hosts.some((h) => h.id === host.id)).toBe(false);
  });

  it("normalizes baseUrl to an origin (strips trailing path/slash)", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773/pair" });
    expect(host.baseUrl).toBe("https://studio.ts.net:3773");
  });

  it("clears needsRepair when re-adding (re-pairing) an existing host", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773" });
    useHostStore.getState().markNeedsRepair(host.id, true);
    expect(useHostStore.getState().hosts.find((h) => h.id === host.id)?.needsRepair).toBe(true);

    const readded = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773" });
    expect(readded.id).toBe(host.id);
    expect(readded.needsRepair).toBe(false);
    expect(useHostStore.getState().hosts.find((h) => h.id === host.id)?.needsRepair).toBe(false);
  });

  it("markNeedsRepair is a no-op when the value already matches (idempotent)", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773" });

    // First call actually changes the flag, so state/host references change.
    useHostStore.getState().markNeedsRepair(host.id, true);
    const stateAfterFirstCall = useHostStore.getState();
    const hostAfterFirstCall = stateAfterFirstCall.hosts.find((h) => h.id === host.id);
    expect(hostAfterFirstCall?.needsRepair).toBe(true);

    // A redundant call with the same value must not touch the store at all.
    useHostStore.getState().markNeedsRepair(host.id, true);
    expect(useHostStore.getState()).toBe(stateAfterFirstCall);
    expect(useHostStore.getState().hosts.find((h) => h.id === host.id)).toBe(hostAfterFirstCall);

    // A brand-new host defaults to needsRepair === undefined; calling with
    // `false` should be treated as already-equal (Boolean(undefined) === false).
    const other = useHostStore
      .getState()
      .addRemoteHost({ label: "Other", baseUrl: "https://other.ts.net:3773" });
    const stateBeforeNoopCall = useHostStore.getState();
    const otherBefore = stateBeforeNoopCall.hosts.find((h) => h.id === other.id);
    useHostStore.getState().markNeedsRepair(other.id, false);
    expect(useHostStore.getState()).toBe(stateBeforeNoopCall);
    expect(useHostStore.getState().hosts.find((h) => h.id === other.id)).toBe(otherBefore);
  });
});
