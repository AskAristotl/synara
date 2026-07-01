// FILE: useHostConnectionStatus.ts
// Purpose: React hook exposing the active host's connection status.
// Layer: Web hook
// Exports: useHostConnectionStatus

import { useEffect, useState } from "react";

import { addWsTransportStateListener, type WsTransportState } from "../wsTransportEvents";
import { mapTransportStateToHostStatus, type HostConnectionStatus } from "./hostConnectionStatus";

export function useHostConnectionStatus(): HostConnectionStatus {
  const [state, setState] = useState<WsTransportState>("connecting");
  useEffect(() => addWsTransportStateListener(setState), []);
  return mapTransportStateToHostStatus(state);
}
