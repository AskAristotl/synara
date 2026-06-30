// apps/web/src/components/hosts/addHostDialog.logic.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Node has no global `localStorage`, and zustand's `createJSONStorage` resolves
// its storage getter eagerly at module-import time (see hostStore.test.ts /
// pairing.test.ts for the same pattern). `addHostDialogLogic` -> `parsePairingLink`
// -> `hostStore`, so even this pure-logic test must stub a working in-memory
// localStorage once, then dynamically import the module under test so it
// captures it.
let validateAddHostInput: typeof import("./addHostDialogLogic").validateAddHostInput;

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
  ({ validateAddHostInput } = await import("./addHostDialogLogic"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("validateAddHostInput", () => {
  it("accepts a valid pairing link", () => {
    expect(validateAddHostInput("https://studio.ts.net:3773/pair#token=ABCD1234WXYZ").valid).toBe(
      true,
    );
  });
  it("rejects a link with no token", () => {
    const r = validateAddHostInput("https://studio.ts.net:3773/pair");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/token|pairing/i);
  });
  it("rejects empty input", () => {
    expect(validateAddHostInput("   ").valid).toBe(false);
  });
});
