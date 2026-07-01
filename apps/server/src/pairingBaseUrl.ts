// FILE: pairingBaseUrl.ts
// Purpose: Resolve the best externally-reachable base URL for the startup
// pairing link. `bindUrl` in main.ts answers "where should the local
// auto-open browser point," which collapses to localhost for wildcard hosts
// (0.0.0.0 / ::). That's wrong for the pairing link: a phone scanning the QR
// code needs an address it can actually reach. This module scans the host's
// network interfaces for a usable address instead, preferring a Tailscale/
// tailnet address (100.64.0.0/10) when one is present.
// Layer: Server startup utility
// Exports: resolvePairingBaseUrl

import type OS from "node:os";

import { formatHostForUrl, isWildcardHost } from "./startupAccess";

export interface ResolvePairingBaseUrlInput {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces: NodeJS.Dict<OS.NetworkInterfaceInfo[]>;
}

export interface ResolvePairingBaseUrlResult {
  readonly baseUrl: string;
  readonly reachable: boolean;
}

const CGNAT_TAILNET_PREFIX = "100.";

/** Second octet range for the CGNAT block (100.64.0.0/10 spans 100.64-100.127.x.x). */
const isTailnetAddress = (address: string): boolean => {
  if (!address.startsWith(CGNAT_TAILNET_PREFIX)) return false;
  const [, secondOctetRaw] = address.split(".");
  const secondOctet = Number(secondOctetRaw);
  return Number.isInteger(secondOctet) && secondOctet >= 64 && secondOctet <= 127;
};

// `family` is typed as "IPv4" | "IPv6" in modern @types/node, but Node <18
// reported it as the numeric constants 4 | 6 at runtime — accept `unknown`
// so both shapes type-check.
const isIPv4 = (family: unknown): boolean => family === "IPv4" || family === 4;

const toBaseUrl = (host: string, port: number): string =>
  `http://${formatHostForUrl(host)}:${port}`;

/**
 * Resolves the base URL to embed in the startup pairing link.
 *
 * - Concrete `host` (not a wildcard bind address): used directly.
 * - Wildcard `host` (0.0.0.0 / :: / empty / undefined): scans `interfaces`
 *   for a non-internal IPv4 address, preferring a tailnet (100.64.0.0/10)
 *   address over any other LAN address.
 * - Wildcard with no usable address found: falls back to localhost and
 *   reports `reachable: false` so callers can warn the user.
 */
export function resolvePairingBaseUrl(
  input: ResolvePairingBaseUrlInput,
): ResolvePairingBaseUrlResult {
  const { host, port, interfaces } = input;

  if (host && !isWildcardHost(host)) {
    return { baseUrl: toBaseUrl(host, port), reachable: true };
  }

  let fallbackAddress: string | undefined;
  for (const infos of Object.values(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.internal || !isIPv4(info.family)) continue;
      if (isTailnetAddress(info.address)) {
        return { baseUrl: toBaseUrl(info.address, port), reachable: true };
      }
      if (!fallbackAddress) fallbackAddress = info.address;
    }
  }

  if (fallbackAddress) {
    return { baseUrl: toBaseUrl(fallbackAddress, port), reachable: true };
  }

  return { baseUrl: `http://localhost:${port}`, reachable: false };
}
