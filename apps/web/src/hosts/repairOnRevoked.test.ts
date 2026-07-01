import { describe, expect, it, vi } from "vitest";

import { RevokedHostCredentialError } from "./hostConnection";
import { wrapResolverForRepair } from "./repairOnRevoked";

describe("wrapResolverForRepair", () => {
  it("passes the resolved URL through on success without calling onRevoked", async () => {
    const onRevoked = vi.fn();
    const resolve = vi.fn(async () => "wss://studio.ts.net:3773/ws?wsToken=abc");
    const wrapped = wrapResolverForRepair(resolve, onRevoked);

    await expect(wrapped()).resolves.toBe("wss://studio.ts.net:3773/ws?wsToken=abc");
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it("calls onRevoked with the host id and rethrows on RevokedHostCredentialError", async () => {
    const onRevoked = vi.fn();
    const error = new RevokedHostCredentialError("host_1");
    const resolve = vi.fn(async () => {
      throw error;
    });
    const wrapped = wrapResolverForRepair(resolve, onRevoked);

    await expect(wrapped()).rejects.toBe(error);
    expect(onRevoked).toHaveBeenCalledOnce();
    expect(onRevoked).toHaveBeenCalledWith("host_1");
  });

  it("rethrows other errors without calling onRevoked", async () => {
    const onRevoked = vi.fn();
    const error = new Error("network down");
    const resolve = vi.fn(async () => {
      throw error;
    });
    const wrapped = wrapResolverForRepair(resolve, onRevoked);

    await expect(wrapped()).rejects.toBe(error);
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
