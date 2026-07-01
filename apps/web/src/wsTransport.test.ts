// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_CHANNELS } from "@t3tools/contracts";

import { shouldKeepServerLifecycleStream, WsTransport } from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  sockets.length = 0;
  vi.stubEnv("VITE_WS_URL", "");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("keeps the shared lifecycle stream while either lifecycle channel is active", () => {
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverWelcome]))).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverMaintenanceUpdated]))).toBe(
      true,
    );
    expect(
      shouldKeepServerLifecycleStream(
        new Set([WS_CHANNELS.serverWelcome, WS_CHANNELS.serverMaintenanceUpdated]),
      ),
    ).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverConfigUpdated]))).toBe(false);
  });

  it("normalizes explicit websocket URLs to the RPC endpoint", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    expect(transport.getState()).toBe("connecting");
    // The URL resolver runs asynchronously (even for the legacy string form),
    // so the socket is created a tick after construction.
    await new Promise((r) => setTimeout(r, 0));
    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws");

    transport.dispose();
  });

  it("uses the desktop bridge URL before falling back to the browser location", async () => {
    const getWsUrl = vi.fn().mockReturnValue("ws://127.0.0.1:53036/?token=old");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", port: "3020" },
        desktopBridge: { getWsUrl },
      },
    });

    const transport = new WsTransport();

    expect(getWsUrl).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:53036/ws?token=old");

    transport.dispose();
  });

  it("falls back to the current browser host when no desktop bridge URL exists", async () => {
    const transport = new WsTransport();

    await new Promise((r) => setTimeout(r, 0));
    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws");

    transport.dispose();
  });

  it("notifies state listeners and replays the current state on demand", () => {
    const transport = new WsTransport();
    const listener = vi.fn();

    const unsubscribe = transport.onStateChange(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledWith("connecting");

    listener.mockClear();
    transport.dispose();

    expect(listener).toHaveBeenCalledWith("disposed");

    listener.mockClear();
    unsubscribe();
    transport.dispose();

    expect(listener).not.toHaveBeenCalled();
  });

  it("calls the async URL resolver for each session", async () => {
    const calls: number[] = [];
    let n = 0;
    const resolveUrl = async () => {
      n += 1;
      calls.push(n);
      return "ws://127.0.0.1:65535/ws?wsToken=T" + n; // unreachable port -> connect fails
    };
    const transport = new WsTransport(resolveUrl);
    // Allow the initial session attempt to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    transport.dispose();
  });
});
