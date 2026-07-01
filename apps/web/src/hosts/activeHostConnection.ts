// apps/web/src/hosts/activeHostConnection.ts
// FILE: activeHostConnection.ts
// Purpose: Resolve the HostConnection for the currently active host.
// Layer: Web transport
// Exports: getActiveHostConnection

import { isElectron } from "../env";
import { type Host, useHostStore } from "./hostStore";
import { makeHostConnection, type HostConnection } from "./hostConnection";

export function getActiveHostConnection(): HostConnection {
  const state = useHostStore.getState();
  let host: Host = state.getActiveHost();
  // The local host only exists on desktop; a browser must always be on a remote host.
  if (!isElectron && host.kind === "local") {
    const firstRemote = state.hosts.find((h) => h.kind === "remote");
    host = firstRemote ?? host;
  }
  return makeHostConnection(host);
}
