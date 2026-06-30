import { describe, expect, it } from "vitest";

import { makeSecureCredentialStore } from "./secureCredentialStore";

function inMemoryDeps() {
  let file = "";
  return {
    isEncryptionAvailable: () => true,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`),
    decrypt: (buf: Buffer) => buf.toString().replace(/^enc:/, ""),
    readFile: async () => file,
    writeFile: async (contents: string) => void (file = contents),
    filePath: "/tmp/creds.json",
  };
}

describe("makeSecureCredentialStore", () => {
  it("encrypts values on set and decrypts on get", async () => {
    const store = makeSecureCredentialStore(inMemoryDeps());
    await store.set("synara:host-credential:host_1", "TOKEN");
    expect(await store.get("synara:host-credential:host_1")).toBe("TOKEN");
  });

  it("returns null for an unknown key", async () => {
    const store = makeSecureCredentialStore(inMemoryDeps());
    expect(await store.get("missing")).toBeNull();
  });

  it("deletes a key", async () => {
    const store = makeSecureCredentialStore(inMemoryDeps());
    await store.set("k", "v");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });
});
