// FILE: wsTransport.ts
// Purpose: Browser-side Effect RPC transport over the Synara WebSocket endpoint.
// Layer: Web transport
// Exports: WsTransport plus stream-selection helpers used by tests.

import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
  WsRpcGroup,
  type AutomationStreamEvent,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  type ProjectDevServerEvent,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerSettingsUpdatedPayload,
  type TerminalEvent,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
} from "@t3tools/contracts";
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime, Schedule, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import type { WsTransportState } from "./wsTransportEvents";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

type RpcClientEffect = typeof makeRpcClient;
type RpcClientInstance =
  RpcClientEffect extends Effect.Effect<infer Client, any, any> ? Client : never;

class WsTransportRpcError extends Data.TaggedError("WsTransportRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const makeRpcClient = RpcClient.make(WsRpcGroup);

function resolveRpcUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = "/ws";
  return url.toString();
}

function makeSocketUrl(explicitUrl: string | null): string {
  if (explicitUrl) return resolveRpcUrl(explicitUrl);
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const rawUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  return resolveRpcUrl(rawUrl);
}

function makeProtocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  // JSON keeps the wire format symmetric with any server build: a serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs web and server on independently-built copies.
  // The protocol's built-in dial retry is disabled: it would redial forever with
  // this session's frozen URL (whose one-time wsToken expires after 5 minutes).
  // WsTransport owns reconnection and mints a fresh token per session.
  return RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}

function causeToError(cause: Cause.Cause<unknown>): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(String(error));
}

function omitNullUserInputAnswers(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const command = input as { type?: unknown; answers?: unknown };
  if (command.type !== "thread.user-input.respond" || !command.answers) {
    return input;
  }
  if (typeof command.answers !== "object") {
    return input;
  }
  return {
    ...command,
    answers: Object.fromEntries(
      Object.entries(command.answers).filter(
        ([, answer]) => answer !== null && answer !== undefined,
      ),
    ),
  };
}

export function isServerLifecyclePushChannel(channel: string): boolean {
  return channel === WS_CHANNELS.serverWelcome || channel === WS_CHANNELS.serverMaintenanceUpdated;
}

export function shouldKeepServerLifecycleStream(activeChannels: ReadonlySet<string>): boolean {
  return (
    activeChannels.has(WS_CHANNELS.serverWelcome) ||
    activeChannels.has(WS_CHANNELS.serverMaintenanceUpdated)
  );
}

const CONNECT_PROBE_TIMEOUT_MS = 10_000;
const CONNECT_WAIT_TIMEOUT_MS = 8_000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_UNREACHABLE_AFTER_FAILURES = 2;

// The server intentionally FAILS a single stream to force a resubscribe (e.g.
// slow-subscriber buffer overflow → fresh snapshot). Only errors from the RPC
// client itself indicate the connection is gone; everything else is stream-local.
export function isConnectionLevelStreamError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { _tag?: unknown })._tag === "RpcClientError"
  );
}

// Exponential backoff with jitter in [cap/2, cap): concurrent clients spread
// their redials instead of stampeding a just-restarted host.
export function computeReconnectDelayMs(
  failures: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** failures, RECONNECT_MAX_DELAY_MS);
  return Math.round(cap / 2 + random() * (cap / 2));
}

export class WsTransport {
  private readonly resolveUrl: () => Promise<string>;
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly stateListeners = new Set<(state: WsTransportState) => void>();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private sequence = 0;
  private sessionVersion = 0;
  private state: WsTransportState = "connecting";
  private disposed = false;
  private runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> | null = null;
  private clientScope: Scope.Closeable | null = null;
  private sessionReady: Promise<{
    runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
    clientScope: Scope.Closeable;
  }> | null = null;
  private clientPromise: Promise<RpcClientInstance>;
  private reconnectPromise: Promise<RpcClientInstance> | null = null;
  private reconnectFailures = 0;
  private reconnectWake: (() => void) | null = null;
  private readonly proactiveTriggerCleanups: Array<() => void> = [];
  private readonly streamCleanups = new Map<string, () => void>();
  private readonly stoppingStreams = new Set<string>();
  private shellSubscribed = false;
  private readonly threadSubscriptions = new Map<string, unknown>();

  constructor(url?: string | (() => Promise<string>)) {
    this.resolveUrl =
      typeof url === "function"
        ? url
        : typeof url === "string"
          ? () => Promise.resolve(resolveRpcUrl(url))
          : () => Promise.resolve(makeSocketUrl(null));
    const session = this.createSession();
    this.clientPromise = session.clientPromise;
    // The initial connection enters the same persistent retry loop as any drop.
    void session.clientPromise.catch(() => {
      if (!this.disposed) void this.reconnect().catch(() => undefined);
    });
    this.registerProactiveReconnectTriggers();
  }

  // Phones and laptops kill sockets on background/sleep; redial the moment the
  // environment says we're back instead of waiting for failure detection.
  private registerProactiveReconnectTriggers(): void {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const kick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      this.requestReconnectNow();
    };
    window.addEventListener("online", kick);
    window.addEventListener("focus", kick);
    window.addEventListener("pageshow", kick);
    this.proactiveTriggerCleanups.push(() => {
      window.removeEventListener("online", kick);
      window.removeEventListener("focus", kick);
      window.removeEventListener("pageshow", kick);
    });
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", kick);
      this.proactiveTriggerCleanups.push(() =>
        document.removeEventListener("visibilitychange", kick),
      );
    }
  }

  /** Attempt to reconnect right now: skip any backoff sleep in progress. */
  requestReconnectNow(): void {
    if (this.disposed) return;
    if (this.reconnectWake) {
      this.reconnectWake();
      return;
    }
    if (this.reconnectPromise) return;
    if (this.state !== "open") {
      void this.reconnect().catch(() => undefined);
    }
  }

  private requireRuntime(): ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> {
    if (!this.runtime) throw new Error("Transport runtime not ready");
    return this.runtime;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    _options?: { readonly timeoutMs?: number | null },
  ): Promise<T> {
    if (this.disposed) throw new Error("Transport disposed");
    const client = await this.getClient();

    if (method === WS_METHODS.gitRunStackedAction) {
      return (await this.runGitActionStream(client, params)) as T;
    }

    if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
      this.shellSubscribed = true;
      this.startShellStream(client);
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.unsubscribeShell) {
      this.shellSubscribed = false;
      this.stopStream("orchestration.shell");
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.subscribeThread) {
      const threadId = (params as { threadId: string }).threadId;
      this.threadSubscriptions.set(threadId, params);
      this.startThreadStream(client, threadId, params as never);
      return undefined as T;
    }
    if (method === ORCHESTRATION_WS_METHODS.unsubscribeThread) {
      const threadId = (params as { threadId: string }).threadId;
      this.threadSubscriptions.delete(threadId);
      this.stopStream(`orchestration.thread:${threadId}`);
      return undefined as T;
    }

    const rpcInput =
      method === ORCHESTRATION_WS_METHODS.dispatchCommand
        ? (params as { command: unknown }).command
        : (params ?? {});
    const normalizedRpcInput = omitNullUserInputAnswers(rpcInput);
    const call = (
      client as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<unknown, WsTransportRpcError, never>
      >
    )[method];
    if (!call) throw new WsTransportRpcError({ message: `Unknown RPC method: ${method}` });
    try {
      return (await this.requireRuntime().runPromise(call(normalizedRpcInput))) as T;
    } catch (error) {
      // A request failing at the RPC-client layer means the socket died between
      // heartbeats — start reconnecting now rather than waiting for a stream exit.
      if (isConnectionLevelStreamError(error)) this.requestReconnectNow();
      throw error;
    }
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: { readonly replayLatest?: boolean },
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
      this.startChannelStream(channel);
    }

    const wrappedListener = (message: WsPush) => listener(message as WsPushMessage<C>);
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) wrappedListener(latest);
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
        this.stopChannelStream(channel);
      }
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  onStateChange(
    listener: (state: WsTransportState) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.stateListeners.add(listener);
    if (options?.replayCurrent) {
      listener(this.state);
    }

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): WsTransportState {
    return this.state;
  }

  dispose() {
    this.disposed = true;
    this.setState("disposed");
    this.reconnectWake?.();
    for (const cleanup of this.proactiveTriggerCleanups) cleanup();
    this.proactiveTriggerCleanups.length = 0;
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    // Dispose can race with initial connection or reconnect promises. Mark them
    // handled before closing the runtime so test/browser teardown stays quiet.
    void this.clientPromise.catch(() => undefined);
    void this.reconnectPromise?.catch(() => undefined);
    const ready = this.sessionReady;
    void ready
      ?.then(({ runtime, clientScope }) =>
        runtime.runPromise(Scope.close(clientScope, Exit.void)).finally(() => runtime.dispose()),
      )
      .catch(() => undefined);
  }

  // A resolved RPC client only proves the plumbing was built — the socket dials
  // lazily. Round-trip a cheap RPC so "open" reflects real connectivity.
  private probeConnection(
    runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>,
    client: RpcClientInstance,
  ): Promise<void> {
    const call = (
      client as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<unknown, unknown, never>
      >
    )[WS_METHODS.serverGetSettings];
    if (!call) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for the host connection probe.")),
        CONNECT_PROBE_TIMEOUT_MS,
      );
      runtime.runPromise(call({})).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private createSession() {
    const sessionVersion = ++this.sessionVersion;
    const sessionReady = this.resolveUrl().then((url) => {
      const runtime = ManagedRuntime.make(makeProtocolLayer(url));
      const clientScope = runtime.runSync(Scope.make());
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        this.runtime = runtime;
        this.clientScope = clientScope;
      }
      return { runtime, clientScope };
    });
    this.sessionReady = sessionReady;

    const clientPromise = sessionReady
      .then(async ({ runtime, clientScope }) => {
        const client = await runtime.runPromise(Scope.provide(clientScope)(makeRpcClient));
        await this.probeConnection(runtime, client);
        return client;
      })
      .then((client) => {
        if (!this.disposed && this.sessionVersion === sessionVersion) {
          this.setState("open");
        }
        return client;
      })
      .catch((error) => {
        if (!this.disposed && this.sessionVersion === sessionVersion) {
          this.setState("closed");
        }
        throw error;
      });
    return { clientPromise };
  }

  private async getClient(): Promise<RpcClientInstance> {
    try {
      return await this.clientPromise;
    } catch {
      if (this.disposed) throw new Error("Transport disposed");
      return await this.waitForReconnect();
    }
  }

  // Bound how long a caller waits for a live connection: user actions should
  // fail fast with a clear error while the reconnect loop keeps running.
  private waitForReconnect(): Promise<RpcClientInstance> {
    const reconnecting = this.reconnect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Host connection is offline; reconnecting in the background.")),
        CONNECT_WAIT_TIMEOUT_MS,
      );
      reconnecting.then(
        (client) => {
          clearTimeout(timer);
          resolve(client);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private reconnect(): Promise<RpcClientInstance> {
    if (this.reconnectPromise) return this.reconnectPromise;

    const oldReady = this.sessionReady;
    // The loop restarts every registered stream after it connects, so their
    // interrupts here are intentional stops, not failures to react to.
    for (const key of this.streamCleanups.keys()) this.stoppingStreams.add(key);
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();

    this.setState("connecting");

    void oldReady
      ?.then(({ runtime, clientScope }) =>
        runtime.runPromise(Scope.close(clientScope, Exit.void)).finally(() => runtime.dispose()),
      )
      .catch(() => undefined);

    this.reconnectPromise = this.runReconnectLoop().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private setState(state: WsTransportState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break reconnect or RPC state transitions.
      }
    }
  }

  private async runReconnectLoop(): Promise<RpcClientInstance> {
    for (;;) {
      await this.sleepUntilNextAttempt(computeReconnectDelayMs(this.reconnectFailures));
      if (this.disposed) throw new Error("Transport disposed");

      const session = this.createSession();
      this.clientPromise = session.clientPromise;
      try {
        const client = await session.clientPromise;
        if (this.disposed) throw new Error("Transport disposed");
        this.reconnectFailures = 0;
        for (const channel of this.listeners.keys()) {
          this.startChannelStream(channel as WsPushChannel);
        }
        if (this.shellSubscribed) {
          this.startShellStream(client);
        }
        for (const [threadId, input] of this.threadSubscriptions) {
          this.startThreadStream(client, threadId, input);
        }
        return client;
      } catch (error) {
        if (this.disposed) throw error;
        this.reconnectFailures += 1;
        // Keep retrying, but surface "unreachable" once it stops looking like a blip.
        if (this.reconnectFailures >= RECONNECT_UNREACHABLE_AFTER_FAILURES) {
          this.setState("closed");
        }
        // Dispose this attempt's runtime/socket before dialing again.
        const failedReady = this.sessionReady;
        void failedReady
          ?.then(({ runtime, clientScope }) =>
            runtime
              .runPromise(Scope.close(clientScope, Exit.void))
              .finally(() => runtime.dispose()),
          )
          .catch(() => undefined);
      }
    }
  }

  private sleepUntilNextAttempt(ms: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.reconnectWake = null;
        resolve();
      }, ms);
      this.reconnectWake = () => {
        clearTimeout(timer);
        this.reconnectWake = null;
        resolve();
      };
    });
  }

  private emit<C extends WsPushChannel>(channel: C, data: WsPushMessage<C>["data"]): void {
    const message = {
      type: "push" as const,
      sequence: ++this.sequence,
      channel,
      data,
    } as WsPush;
    this.latestPushByChannel.set(channel, message);
    const listeners = this.listeners.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  private startChannelStream(channel: WsPushChannel): void {
    void this.getClient()
      .then((client) => {
        const restartChannel = () => {
          if (this.listeners.has(channel)) {
            this.startChannelStream(channel);
          }
        };

        if (isServerLifecyclePushChannel(channel)) {
          this.startLifecycleStream(client);
        } else if (channel === WS_CHANNELS.serverConfigUpdated) {
          this.startStream(
            "server.config",
            client[WS_METHODS.subscribeServerConfig]({}),
            (event: ServerConfigStreamEvent) => {
              if (event.type === "snapshot") {
                this.emit(WS_CHANNELS.serverConfigUpdated, {
                  issues: event.config.issues,
                  providers: event.config.providers,
                });
              } else if (event.type === "configUpdated") {
                this.emit(WS_CHANNELS.serverConfigUpdated, event.payload);
              }
            },
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
          this.startStream(
            "server.providers",
            client[WS_METHODS.subscribeServerProviderStatuses]({}),
            (payload: ServerProviderStatusesUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverProviderStatusesUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverSettingsUpdated) {
          this.startStream(
            "server.settings",
            client[WS_METHODS.subscribeServerSettings]({}),
            (payload: ServerSettingsUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverSettingsUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.terminalEvent) {
          this.startStream(
            "terminal.events",
            client[WS_METHODS.subscribeTerminalEvents]({}),
            (event: TerminalEvent) => this.emit(WS_CHANNELS.terminalEvent, event),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.projectDevServerEvent) {
          this.startStream(
            "project.devServers",
            client[WS_METHODS.subscribeProjectDevServerEvents]({}),
            (event: ProjectDevServerEvent) => this.emit(WS_CHANNELS.projectDevServerEvent, event),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.automationEvent) {
          this.startStream(
            "automation.events",
            client[WS_METHODS.subscribeAutomationEvents]({}),
            (event: AutomationStreamEvent) => this.emit(WS_CHANNELS.automationEvent, event),
            restartChannel,
          );
        } else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent) {
          this.startStream(
            "orchestration.domain",
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
            (event: OrchestrationEvent) => this.emit(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
            restartChannel,
          );
        }
      })
      .catch((error) => {
        if (this.disposed || !this.listeners.has(channel)) return;
        console.warn("WebSocket RPC channel failed to start", error);
        // While disconnected the reconnect loop owns recovery (it restarts every
        // subscribed channel on success); only self-retry when the transport is open.
        if (this.state === "open") {
          setTimeout(() => this.startChannelStream(channel), 500);
        }
      });
  }

  private stopChannelStream(channel: WsPushChannel): void {
    if (isServerLifecyclePushChannel(channel)) {
      if (!this.shouldKeepLifecycleStream()) this.stopStream("server.lifecycle");
    } else if (channel === WS_CHANNELS.serverConfigUpdated) this.stopStream("server.config");
    else if (channel === WS_CHANNELS.serverProviderStatusesUpdated)
      this.stopStream("server.providers");
    else if (channel === WS_CHANNELS.serverSettingsUpdated) this.stopStream("server.settings");
    else if (channel === WS_CHANNELS.terminalEvent) this.stopStream("terminal.events");
    else if (channel === WS_CHANNELS.projectDevServerEvent) this.stopStream("project.devServers");
    else if (channel === WS_CHANNELS.automationEvent) this.stopStream("automation.events");
    else if (channel === ORCHESTRATION_WS_CHANNELS.domainEvent)
      this.stopStream("orchestration.domain");
  }

  private shouldKeepLifecycleStream(): boolean {
    return shouldKeepServerLifecycleStream(new Set(this.listeners.keys()));
  }

  private startLifecycleStream(client: RpcClientInstance): void {
    const restartLifecycle = () => {
      if (!this.shouldKeepLifecycleStream()) return;
      void this.getClient()
        .then((nextClient) => this.startLifecycleStream(nextClient))
        .catch((error) => console.warn("WebSocket RPC lifecycle stream failed to restart", error));
    };
    this.startStream(
      "server.lifecycle",
      client[WS_METHODS.subscribeServerLifecycle]({}),
      (event: ServerLifecycleStreamEvent) => {
        if (event.type === "welcome") {
          this.emit(WS_CHANNELS.serverWelcome, event.payload);
        } else if (event.type === "maintenance") {
          this.emit(WS_CHANNELS.serverMaintenanceUpdated, event);
        }
      },
      restartLifecycle,
    );
  }

  private startShellStream(client: RpcClientInstance): void {
    const restartShell = () => {
      void this.getClient()
        .then((nextClient) => this.startShellStream(nextClient))
        .catch((error) => console.warn("WebSocket RPC shell stream failed to restart", error));
    };
    this.startStream(
      "orchestration.shell",
      client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
      (event: OrchestrationShellStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.shellEvent, event),
      restartShell,
    );
  }

  private startThreadStream(client: RpcClientInstance, threadId: string, input: unknown): void {
    const key = `orchestration.thread:${threadId}`;
    this.stopStream(key);
    this.stoppingStreams.delete(key);
    const restartThread = () => {
      void this.getClient()
        .then((nextClient) => this.startThreadStream(nextClient, threadId, input))
        .catch((error) => console.warn("WebSocket RPC thread stream failed to restart", error));
    };
    this.startStream(
      key,
      client[ORCHESTRATION_WS_METHODS.subscribeThread](input as never),
      (event: OrchestrationThreadStreamItem) =>
        this.emit(ORCHESTRATION_WS_CHANNELS.threadEvent, event),
      restartThread,
    );
  }

  private startStream<T>(
    key: string,
    stream: unknown,
    listener: (event: T) => void,
    restart?: (() => void) | undefined,
  ): void {
    if (this.streamCleanups.has(key)) return;
    this.stoppingStreams.delete(key);
    const runnableStream = stream as Stream.Stream<T, WsTransportRpcError, never>;
    const cancel = this.requireRuntime().runCallback(
      Stream.runForEach(runnableStream, (event) => Effect.sync(() => listener(event))),
      {
        onExit: (exit) => {
          if (this.streamCleanups.get(key) === cancel) {
            this.streamCleanups.delete(key);
          }
          const wasStoppedIntentionally = this.stoppingStreams.delete(key);
          if (wasStoppedIntentionally || this.disposed) {
            return;
          }
          if (!Exit.isFailure(exit)) {
            return;
          }
          if (!restart) {
            if (!Cause.hasInterruptsOnly(exit.cause)) {
              console.warn("WebSocket RPC stream failed", causeToError(exit.cause));
            }
            return;
          }
          const interruptedOnly = Cause.hasInterruptsOnly(exit.cause);
          const connectionLevel =
            interruptedOnly || isConnectionLevelStreamError(Cause.squash(exit.cause));
          setTimeout(
            () => {
              if (this.disposed || this.streamCleanups.has(key)) return;
              if (connectionLevel) {
                void this.reconnect()
                  .then(() => restart())
                  .catch((error) => console.warn("WebSocket RPC stream reconnect failed", error));
              } else {
                // Stream-local failure (e.g. server-initiated snapshot resync):
                // the socket is healthy, so just resubscribe this one stream.
                restart();
              }
            },
            interruptedOnly ? 0 : 500,
          );
        },
      },
    );
    this.streamCleanups.set(key, cancel);
  }

  private stopStream(key: string): void {
    const cleanup = this.streamCleanups.get(key);
    if (!cleanup) return;
    this.stoppingStreams.add(key);
    this.streamCleanups.delete(key);
    cleanup();
  }

  private async runGitActionStream(
    client: RpcClientInstance,
    params: unknown,
  ): Promise<GitRunStackedActionResult> {
    let result: GitRunStackedActionResult | null = null;
    await this.requireRuntime().runPromise(
      Stream.runForEach(client[WS_METHODS.gitRunStackedAction](params as never), (event) =>
        Effect.sync(() => {
          this.emit(WS_CHANNELS.gitActionProgress, event as GitActionProgressEvent);
          if ((event as GitActionProgressEvent).kind === "action_finished") {
            result = (event as Extract<GitActionProgressEvent, { kind: "action_finished" }>).result;
          }
        }),
      ),
    );
    if (!result) throw new Error("Git action stream completed without a final result.");
    return result;
  }
}
