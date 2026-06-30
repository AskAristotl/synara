// apps/web/src/hosts/hostStore.ts
// FILE: hostStore.ts
// Purpose: Persisted list of Synara hosts + the active host pointer.
// Layer: Web state
// Exports: Host, HostKind, LOCAL_HOST_ID, useHostStore

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type HostKind = "local" | "remote";

export interface Host {
  readonly id: string;
  readonly label: string;
  readonly kind: HostKind;
  readonly baseUrl: string | null;
  readonly createdAt: number;
  lastConnectedAt: number | null;
}

export const LOCAL_HOST_ID = "local";
const HOST_STORE_STORAGE_KEY = "synara:hosts:v1";

const localHost = (): Host => ({
  id: LOCAL_HOST_ID,
  label: "Local",
  kind: "local",
  baseUrl: null,
  createdAt: 0,
  lastConnectedAt: null,
});

function normalizeBaseUrl(raw: string): string {
  return new URL(raw).origin;
}

function generateHostId(): string {
  return `host_${crypto.randomUUID()}`;
}

export interface HostStoreState {
  hosts: Host[];
  activeHostId: string;
  addRemoteHost: (input: { label: string; baseUrl: string }) => Host;
  removeHost: (hostId: string) => void;
  renameHost: (hostId: string, label: string) => void;
  setActiveHostId: (hostId: string) => void;
  markConnected: (hostId: string, at: number) => void;
  getActiveHost: () => Host;
}

export const useHostStore = create<HostStoreState>()(
  persist(
    (set, get) => ({
      hosts: [localHost()],
      activeHostId: LOCAL_HOST_ID,
      addRemoteHost: ({ label, baseUrl }) => {
        const normalized = normalizeBaseUrl(baseUrl);
        const existing = get().hosts.find((h) => h.kind === "remote" && h.baseUrl === normalized);
        if (existing) {
          set((s) => ({
            hosts: s.hosts.map((h) =>
              h.id === existing.id ? { ...h, label: label.trim() || h.label } : h,
            ),
          }));
          return get().hosts.find((h) => h.id === existing.id)!;
        }
        const host: Host = {
          id: generateHostId(),
          label: label.trim() || normalized,
          kind: "remote",
          baseUrl: normalized,
          createdAt: Date.now(),
          lastConnectedAt: null,
        };
        set((s) => ({ hosts: [...s.hosts, host] }));
        return host;
      },
      removeHost: (hostId) => {
        if (hostId === LOCAL_HOST_ID) return;
        set((s) => {
          const hosts = s.hosts.filter((h) => h.id !== hostId);
          const activeHostId = s.activeHostId === hostId ? LOCAL_HOST_ID : s.activeHostId;
          return { hosts, activeHostId };
        });
      },
      renameHost: (hostId, label) =>
        set((s) => ({
          hosts: s.hosts.map((h) =>
            h.id === hostId ? { ...h, label: label.trim() || h.label } : h,
          ),
        })),
      setActiveHostId: (hostId) => {
        if (!get().hosts.some((h) => h.id === hostId)) return;
        set({ activeHostId: hostId });
      },
      markConnected: (hostId, at) =>
        set((s) => ({
          hosts: s.hosts.map((h) => (h.id === hostId ? { ...h, lastConnectedAt: at } : h)),
        })),
      getActiveHost: () => {
        const s = get();
        return s.hosts.find((h) => h.id === s.activeHostId) ?? localHost();
      },
    }),
    {
      name: HOST_STORE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ hosts: s.hosts, activeHostId: s.activeHostId }),
      merge: (persisted, current) => {
        const candidate = (persisted as Partial<HostStoreState> | undefined) ?? {};
        const remotes = (candidate.hosts ?? []).filter(
          (h): h is Host => !!h && h.kind === "remote" && typeof h.baseUrl === "string",
        );
        const hosts = [localHost(), ...remotes];
        const activeHostId =
          candidate.activeHostId && hosts.some((h) => h.id === candidate.activeHostId)
            ? candidate.activeHostId
            : LOCAL_HOST_ID;
        return { ...current, hosts, activeHostId };
      },
    },
  ),
);
