// FILE: switchActiveHost.ts
// Purpose: Rebuild-on-switch — persist the new active host and reload the shell.
// Layer: Web state
// Exports: switchActiveHost

import { resetAllHostScopedStores } from "./hostScopedStores";
import { useHostStore } from "./hostStore";

export function switchActiveHost(hostId: string, deps?: { reload?: () => void }): void {
  const state = useHostStore.getState();
  if (state.activeHostId === hostId) return;
  if (!state.hosts.some((h) => h.id === hostId)) return;
  state.setActiveHostId(hostId);
  resetAllHostScopedStores();
  const reload = deps?.reload ?? (() => window.location.reload());
  reload();
}
