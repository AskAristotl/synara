import { describe, expect, it } from "vitest";

import { resolvePairingBaseUrl } from "./pairingBaseUrl";

describe("resolvePairingBaseUrl", () => {
  it("uses a concrete host directly", () => {
    const result = resolvePairingBaseUrl({
      host: "192.168.1.50",
      port: 3773,
      interfaces: {},
    });
    expect(result).toEqual({ baseUrl: "http://192.168.1.50:3773", reachable: true });
  });

  it("brackets a concrete IPv6 host", () => {
    const result = resolvePairingBaseUrl({
      host: "fd00::1",
      port: 3773,
      interfaces: {},
    });
    expect(result).toEqual({ baseUrl: "http://[fd00::1]:3773", reachable: true });
  });

  it("prefers a tailnet (100.64.0.0/10) address over a LAN address when host is wildcard", () => {
    const result = resolvePairingBaseUrl({
      host: "0.0.0.0",
      port: 3773,
      interfaces: {
        en0: [
          { address: "192.168.1.50", family: "IPv4", internal: false } as never,
          { address: "100.101.102.103", family: "IPv4", internal: false } as never,
        ],
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      },
    });
    expect(result).toEqual({ baseUrl: "http://100.101.102.103:3773", reachable: true });
  });

  it("falls back to the first non-internal IPv4 when no tailnet address is present", () => {
    const result = resolvePairingBaseUrl({
      host: "::",
      port: 3773,
      interfaces: {
        en0: [{ address: "192.168.1.50", family: "IPv4", internal: false } as never],
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      },
    });
    expect(result).toEqual({ baseUrl: "http://192.168.1.50:3773", reachable: true });
  });

  it("falls back to localhost with reachable:false when only internal/loopback interfaces exist", () => {
    const result = resolvePairingBaseUrl({
      host: "0.0.0.0",
      port: 3773,
      interfaces: {
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      },
    });
    expect(result).toEqual({ baseUrl: "http://localhost:3773", reachable: false });
  });

  it("falls back to localhost with reachable:false when host is undefined and no interfaces given", () => {
    const result = resolvePairingBaseUrl({
      host: undefined,
      port: 3773,
      interfaces: {},
    });
    expect(result).toEqual({ baseUrl: "http://localhost:3773", reachable: false });
  });

  it("handles numeric IPv4 family (Node < 18 shape) when scanning interfaces", () => {
    const result = resolvePairingBaseUrl({
      host: "0.0.0.0",
      port: 3773,
      interfaces: {
        en0: [{ address: "192.168.1.50", family: 4, internal: false } as never],
      },
    });
    expect(result).toEqual({ baseUrl: "http://192.168.1.50:3773", reachable: true });
  });

  it("ignores IPv6 interface entries when scanning for a fallback address", () => {
    const result = resolvePairingBaseUrl({
      host: "::",
      port: 3773,
      interfaces: {
        en0: [
          { address: "fe80::1", family: "IPv6", internal: false } as never,
          { address: "192.168.1.50", family: "IPv4", internal: false } as never,
        ],
      },
    });
    expect(result).toEqual({ baseUrl: "http://192.168.1.50:3773", reachable: true });
  });

  it("treats an empty-string host as wildcard", () => {
    const result = resolvePairingBaseUrl({
      host: "",
      port: 3773,
      interfaces: {
        en0: [{ address: "100.64.0.5", family: "IPv4", internal: false } as never],
      },
    });
    expect(result).toEqual({ baseUrl: "http://100.64.0.5:3773", reachable: true });
  });

  it("does not treat a loopback host as wildcard, and reports it as-is", () => {
    const result = resolvePairingBaseUrl({
      host: "127.0.0.1",
      port: 3773,
      interfaces: {},
    });
    expect(result).toEqual({ baseUrl: "http://127.0.0.1:3773", reachable: true });
  });
});
