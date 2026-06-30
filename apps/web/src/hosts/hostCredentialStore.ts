// apps/web/src/hosts/hostCredentialStore.ts
// FILE: hostCredentialStore.ts
// Purpose: Secure-ish storage for per-host bearer credentials. Uses the desktop
//          keychain bridge when present, else localStorage (tailnet-scoped token).
// Layer: Web state
// Exports: HostCredentialStore, getHostCredentialStore

const KEY_PREFIX = "synara:host-credential:";

export interface HostCredentialStore {
  get(hostId: string): Promise<string | null>;
  set(hostId: string, credential: string): Promise<void>;
  delete(hostId: string): Promise<void>;
}

function localStorageStore(): HostCredentialStore {
  const key = (hostId: string) => `${KEY_PREFIX}${hostId}`;
  return {
    get: async (hostId) => localStorage.getItem(key(hostId)),
    set: async (hostId, credential) => localStorage.setItem(key(hostId), credential),
    delete: async (hostId) => localStorage.removeItem(key(hostId)),
  };
}

export function getHostCredentialStore(): HostCredentialStore {
  const bridge = window.desktopBridge?.secureCredentialStore;
  if (bridge) {
    return {
      get: (hostId) => bridge.get(`${KEY_PREFIX}${hostId}`),
      set: (hostId, credential) => bridge.set(`${KEY_PREFIX}${hostId}`, credential),
      delete: (hostId) => bridge.delete(`${KEY_PREFIX}${hostId}`),
    };
  }
  return localStorageStore();
}
