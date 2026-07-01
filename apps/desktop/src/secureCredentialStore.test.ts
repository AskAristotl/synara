import { describe, expect, it } from "vitest";

import { makeSecureCredentialStore, type SecureCredentialStoreDeps } from "./secureCredentialStore";

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

  it("falls back to storing plaintext when encryption is unavailable", async () => {
    let file = "";
    let encryptCalls = 0;
    const deps: SecureCredentialStoreDeps = {
      isEncryptionAvailable: () => false,
      encrypt: (plain: string) => {
        encryptCalls += 1;
        return Buffer.from(`enc:${plain}`);
      },
      decrypt: (buf: Buffer) => buf.toString().replace(/^enc:/, ""),
      readFile: async () => file,
      writeFile: async (contents: string) => void (file = contents),
      filePath: "/tmp/creds.json",
    };
    const store = makeSecureCredentialStore(deps);

    await store.set("synara:host-credential:host_1", "TOKEN");

    expect(await store.get("synara:host-credential:host_1")).toBe("TOKEN");
    // The stored file must hold the raw plaintext value, not base64 ciphertext.
    expect(file).toContain("TOKEN");
    expect(file).not.toContain("enc:TOKEN");
    expect(encryptCalls).toBe(0);
  });

  it("returns null when decoding a stored value fails (corrupted ciphertext)", async () => {
    let file = "";
    const deps: SecureCredentialStoreDeps = {
      isEncryptionAvailable: () => true,
      encrypt: (plain: string) => Buffer.from(`enc:${plain}`),
      decrypt: () => {
        throw new Error("bad cipher");
      },
      readFile: async () => file,
      writeFile: async (contents: string) => void (file = contents),
      filePath: "/tmp/creds.json",
    };
    const store = makeSecureCredentialStore(deps);

    await store.set("synara:host-credential:host_1", "TOKEN");

    await expect(store.get("synara:host-credential:host_1")).resolves.toBeNull();
  });
});
