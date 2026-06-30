// FILE: secureCredentialStore.ts
// Purpose: Encrypted on-disk credential map (Electron safeStorage), DI for tests.
// Layer: Desktop main
// Exports: makeSecureCredentialStore, SecureCredentialStoreDeps

export interface SecureCredentialStoreDeps {
  isEncryptionAvailable: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (cipher: Buffer) => string;
  readFile: () => Promise<string>;
  writeFile: (contents: string) => Promise<void>;
  filePath: string;
}

interface StoreShape {
  [key: string]: string; // base64 ciphertext (or plaintext when encryption unavailable)
}

export function makeSecureCredentialStore(deps: SecureCredentialStoreDeps) {
  const encryptionAvailable = deps.isEncryptionAvailable();

  async function load(): Promise<StoreShape> {
    try {
      const raw = await deps.readFile();
      return raw ? (JSON.parse(raw) as StoreShape) : {};
    } catch {
      return {};
    }
  }

  function encode(value: string): string {
    return encryptionAvailable ? deps.encrypt(value).toString("base64") : value;
  }
  function decode(stored: string): string {
    return encryptionAvailable ? deps.decrypt(Buffer.from(stored, "base64")) : stored;
  }

  return {
    async get(key: string): Promise<string | null> {
      const store = await load();
      const stored = store[key];
      if (stored === undefined) return null;
      try {
        return decode(stored);
      } catch {
        return null;
      }
    },
    async set(key: string, value: string): Promise<void> {
      const store = await load();
      store[key] = encode(value);
      await deps.writeFile(JSON.stringify(store));
    },
    async delete(key: string): Promise<void> {
      const store = await load();
      delete store[key];
      await deps.writeFile(JSON.stringify(store));
    },
  };
}
