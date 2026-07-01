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

  it("runs remaining resets even when one reset throws", () => {
    let count = 0;
    registerHostScopedReset(() => {
      throw new Error("boom");
    });
    registerHostScopedReset(() => (count += 1));
    resetAllHostScopedStores();
    expect(count).toBe(1);
  });
});
