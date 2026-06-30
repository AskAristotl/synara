import { describe, expect, it } from "vitest";

import { registerHostScopedReset, resetAllHostScopedStores } from "./hostScopedStores";

describe("hostScopedStores", () => {
  it("invokes every registered reset", () => {
    let a = 0;
    let b = 0;
    registerHostScopedReset(() => (a += 1));
    registerHostScopedReset(() => (b += 1));
    resetAllHostScopedStores();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
