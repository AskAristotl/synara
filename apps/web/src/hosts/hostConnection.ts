// apps/web/src/hosts/hostConnection.ts
// FILE: hostConnection.ts
// Purpose: Host-aware auth fetch + socket-URL resolution. Local hosts keep the
//          existing same-origin/loopback path; remote hosts use per-host bearer.
// Layer: Web transport
// Exports: HostConnection, makeHostConnection, MissingHostCredentialError

import type { Host } from "./hostStore";
import { getHostCredentialStore, type HostCredentialStore } from "./hostCredentialStore";

export class MissingHostCredentialError extends Error {
  constructor(hostId: string) {
    super(`No stored credential for host ${hostId}; re-pair required.`);
    this.name = "MissingHostCredentialError";
  }
}

export interface HostConnection {
  readonly host: Host;
  requestAuthJson<T>(
    path: string,
    options?: { method?: "GET" | "POST"; body?: unknown },
  ): Promise<T>;
  resolveSocketUrl(): Promise<string>;
}

function toWsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url;
}

function localSocketUrl(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const raw =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  const url = new URL(raw);
  url.pathname = "/ws";
  return url.toString();
}

export function makeHostConnection(
  host: Host,
  deps?: { credentials?: HostCredentialStore },
): HostConnection {
  const credentials = deps?.credentials ?? getHostCredentialStore();

  async function bearer(): Promise<string> {
    const token = await credentials.get(host.id);
    if (!token) throw new MissingHostCredentialError(host.id);
    return token;
  }

  async function requestAuthJson<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    if (host.kind === "remote" && !host.baseUrl)
      throw new Error(`Host ${host.id} is missing a baseUrl; cannot make a remote request.`);
    const hasBody = options.body !== undefined;
    const init: RequestInit =
      host.kind === "local"
        ? {
            method: options.method ?? "GET",
            credentials: "same-origin",
            ...(hasBody
              ? {
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(options.body),
                }
              : {}),
          }
        : {
            method: options.method ?? "GET",
            credentials: "omit",
            headers: {
              Authorization: `Bearer ${await bearer()}`,
              ...(hasBody ? { "Content-Type": "application/json" } : {}),
            },
            ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
          };

    const target = host.kind === "local" ? path : `${host.baseUrl}${path}`;
    const response = await fetch(target, init);
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : `Auth request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  }

  async function resolveSocketUrl(): Promise<string> {
    if (host.kind === "local" || !host.baseUrl) return localSocketUrl();
    const { token } = await requestAuthJson<{ token: string }>("/api/auth/ws-token", {
      method: "POST",
    });
    const url = toWsUrl(host.baseUrl);
    url.searchParams.set("wsToken", token);
    return url.toString();
  }

  return { host, requestAuthJson, resolveSocketUrl };
}
