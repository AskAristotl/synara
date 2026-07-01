import type { ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { registerHostScopedReset } from "./hosts/hostScopedStores";

const LATEST_PROJECT_STORAGE_KEY = "synara:latest-project:v1";

interface LatestProjectStore {
  latestProjectId: ProjectId | null;
  setLatestProjectId: (projectId: ProjectId) => void;
  clearLatestProjectId: (projectId?: ProjectId) => void;
}

export const useLatestProjectStore = create<LatestProjectStore>()(
  persist(
    (set) => ({
      latestProjectId: null,
      setLatestProjectId: (projectId) => set({ latestProjectId: projectId }),
      clearLatestProjectId: (projectId) =>
        set((state) => {
          if (projectId && state.latestProjectId !== projectId) {
            return state;
          }
          if (state.latestProjectId === null) {
            return state;
          }
          return { latestProjectId: null };
        }),
    }),
    {
      name: LATEST_PROJECT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Guard against a corrupt persisted value (non-string) reaching consumers
      // that treat it as a project id.
      merge: (persisted, current) => {
        const persistedId = (persisted as { latestProjectId?: unknown } | undefined)
          ?.latestProjectId;
        return {
          ...current,
          latestProjectId: typeof persistedId === "string" ? (persistedId as ProjectId) : null,
        };
      },
    },
  ),
);

// Reset on host switch — the latest project id references one host's projects.
registerHostScopedReset(() =>
  useLatestProjectStore.setState(useLatestProjectStore.getInitialState(), true),
);
