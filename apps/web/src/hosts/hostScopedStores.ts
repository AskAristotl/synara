// FILE: hostScopedStores.ts
// Purpose: Registry of store resets to run when switching the active host.
// Layer: Web state
// Exports: registerHostScopedReset, resetAllHostScopedStores

const resets = new Set<() => void>();

export function registerHostScopedReset(reset: () => void): void {
  resets.add(reset);
}

export function resetAllHostScopedStores(): void {
  for (const reset of resets) {
    try {
      reset();
    } catch {
      // A failing reset must not block the host switch.
    }
  }
}
