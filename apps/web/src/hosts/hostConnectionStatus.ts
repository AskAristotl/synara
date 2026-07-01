// FILE: hostConnectionStatus.ts
// Purpose: Map raw transport state to a user-facing host connection status.
// Layer: Web state
// Exports: HostConnectionStatus, mapTransportStateToHostStatus

import type { WsTransportState } from "../wsTransportEvents";

export type HostConnectionStatus = "connected" | "connecting" | "unreachable";

export function mapTransportStateToHostStatus(state: WsTransportState): HostConnectionStatus {
  switch (state) {
    case "open":
      return "connected";
    case "connecting":
      return "connecting";
    default:
      return "unreachable";
  }
}
