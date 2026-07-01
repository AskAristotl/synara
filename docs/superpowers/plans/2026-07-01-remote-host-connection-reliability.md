# Remote Host Connection Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote-host connections self-healing (persistent reconnect, proactive redial, truthful status) and stop UI desync after drops, per `docs/superpowers/specs/2026-07-01-remote-host-connection-reliability-analysis.md`.

**Architecture:** `WsTransport` (apps/web/src/wsTransport.ts) becomes the single owner of reconnection: Effect's protocol-internal dial retry is disabled, a persistent jittered-backoff loop replaces the single-shot reconnect, "open" state is confirmed by a round-trip probe, stream failures are classified (server stream resync vs connection loss), and browser lifecycle events (`online`, `visibilitychange`, `pageshow`, `focus`) trigger immediate redials. On reconnect the app blanket-invalidates react-query caches. Secondary hardening: auth fetch timeout, lazy domain-event channel, in-place banner retry, server TCP keepalive.

**Tech Stack:** TypeScript, Effect 4.0.0-beta (effect-smol) RPC/Socket, React, zustand, @tanstack/react-query, Vitest (`bun run test`), Node http server.

## Global Constraints

- NEVER run `bun test` — always `bun run test` (Vitest).
- `bun fmt`, `bun lint`, `bun typecheck` must pass; bundle them into ONE final verification pass (Task 10), not per-task.
- No AI attribution trailers in commits.
- In new/modified transport code use global `setTimeout`/`clearTimeout` (NOT `window.setTimeout`) — tests stub `window` with a bare object.
- Match existing file style: `// FILE:` headers, exported pure helpers for tests.

---

### Task 1: Auth fetch timeout in hostConnection

**Files:**

- Modify: `apps/web/src/hosts/hostConnection.ts` (requestAuthJson, ~line 68-114)
- Test: `apps/web/src/hosts/hostConnection.test.ts`

**Interfaces:**

- Produces: `requestAuthJson` now rejects with `Error(/timed out/i)` after 10s of no response. No signature change.

- [ ] **Step 1: Write the failing test** (append to `hostConnection.test.ts` describe block):

```ts
it("aborts auth requests that hang past the timeout", async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const conn = makeHostConnection(remoteHost, { credentials: creds("BEARER123") });
    const pending = conn.requestAuthJson("/api/auth/session");
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run to verify it fails:** `cd apps/web && bun run test src/hosts/hostConnection.test.ts` → new test FAILS (promise never settles / no timeout).

- [ ] **Step 3: Implement.** In `hostConnection.ts`, add near top:

```ts
const AUTH_REQUEST_TIMEOUT_MS = 10_000;
```

Replace `const response = await fetch(target, init);` with:

```ts
// A black-holed network can hang fetch for browser-default minutes; bound it
// so the reconnect loop can move on to its next attempt.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
let response: Response;
try {
  response = await fetch(target, { ...init, signal: controller.signal });
} catch (error) {
  if (controller.signal.aborted) {
    throw new Error(`Request to ${host.label} timed out.`);
  }
  throw error;
} finally {
  clearTimeout(timer);
}
```

- [ ] **Step 4: Run test file again** → all PASS.
- [ ] **Step 5: Commit** — `git add apps/web/src/hosts/hostConnection.ts apps/web/src/hosts/hostConnection.test.ts && git commit -m "fix(web): bound host auth requests with a 10s abort timeout"`

---

### Task 2: Lazy domain-event channel + reconnect handle in wsNativeApi

**Files:**

- Modify: `apps/web/src/wsNativeApi.ts` (remove eager domainEvent subscribe ~line 397-406; lazy logic; new export)
- Test: `apps/web/src/wsNativeApi.test.ts`

**Interfaces:**

- Consumes: `WsTransport.requestReconnectNow(): void` (added in Task 4 — until then the export compiles against the class but is unused; add it in the same session as Task 4 if typecheck complains, or declare after Task 4. ORDER NOTE: implement Task 2's `requestTransportReconnect` export AFTER Task 4 lands if running strictly sequentially; the lazy-channel part is independent.)
- Produces: `export function requestTransportReconnect(): void` (used by Task 7 banner). `onDomainEvent` unchanged signature, now lazily subscribes the `orchestration.domainEvent` transport channel on first listener and unsubscribes on last.

- [ ] **Step 1: Write failing test** (in `wsNativeApi.test.ts`; the existing harness records `subscribeMock` calls per channel):

```ts
it("only subscribes the orchestration domain channel while listeners exist", () => {
  const api = createWsNativeApi(connection);
  const domainCalls = () =>
    subscribeMock.mock.calls.filter(
      ([channel]) => channel === ORCHESTRATION_WS_CHANNELS.domainEvent,
    ).length;
  expect(domainCalls()).toBe(0);
  const off = api.orchestration.onDomainEvent(() => undefined);
  expect(domainCalls()).toBe(1);
  expect(channelListeners.has(ORCHESTRATION_WS_CHANNELS.domainEvent)).toBe(true);
  off();
  expect(channelListeners.has(ORCHESTRATION_WS_CHANNELS.domainEvent)).toBe(false);
});
```

(Adapt `createWsNativeApi(connection)` call to however existing tests construct the api — reuse their fixture.)

- [ ] **Step 2: Run** `bun run test src/wsNativeApi.test.ts` → FAILS (eager subscribe → count is 1 before any listener).

- [ ] **Step 3: Implement.** In `wsNativeApi.ts`:
  - Delete the eager block `transport.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (message) => { ... })`.
  - Add module-level state + helper (near the listener sets):

```ts
let domainEventChannelUnsubscribe: (() => void) | null = null;

// The raw domain-event channel streams EVERY orchestration event; only pay for
// it while something is actually listening.
function syncDomainEventChannelSubscription(transport: WsTransport): void {
  const shouldSubscribe = orchestrationDomainEventListeners.size > 0;
  if (shouldSubscribe && !domainEventChannelUnsubscribe) {
    domainEventChannelUnsubscribe = transport.subscribe(
      ORCHESTRATION_WS_CHANNELS.domainEvent,
      (message) => {
        const payload = message.data;
        for (const listener of orchestrationDomainEventListeners) {
          try {
            listener(payload);
          } catch {
            // Swallow listener errors
          }
        }
      },
    );
  } else if (!shouldSubscribe && domainEventChannelUnsubscribe) {
    domainEventChannelUnsubscribe();
    domainEventChannelUnsubscribe = null;
  }
}
```

- Change `orchestration.onDomainEvent` to:

```ts
      onDomainEvent: (callback) => {
        orchestrationDomainEventListeners.add(callback);
        syncDomainEventChannelSubscription(transport);
        return () => {
          orchestrationDomainEventListeners.delete(callback);
          syncDomainEventChannelSubscription(transport);
        };
      },
```

- In `resetWsNativeApiForTest` and the `import.meta.hot.dispose` block add `domainEventChannelUnsubscribe = null;`.
- Add export (after Task 4 exists; safe to add now if `requestReconnectNow` is declared in the same change set):

```ts
/** Ask the shared transport to attempt a reconnect immediately (no page reload). */
export function requestTransportReconnect(): void {
  instance?.transport.requestReconnectNow();
}
```

- [ ] **Step 4: Run test file** → PASS (mock transport may need a no-op `requestReconnectNow() {}` added to its class).
- [ ] **Step 5: Commit** — `git commit -m "perf(web): subscribe orchestration domain channel lazily"`

---

### Task 3: Fail-fast protocol + connection probe (truthful "open")

**Files:**

- Modify: `apps/web/src/wsTransport.ts` (`makeProtocolLayer`, `createSession`)
- Test: `apps/web/src/wsTransport.test.ts` (behavior covered by Task 4's loop tests; this task is verified by existing tests still passing)

**Interfaces:**

- Produces: `setState("open")` only after an RPC round-trip succeeds. Internal Effect dial retry disabled (`Schedule.recurs(0)`), so a dead socket fails requests/streams immediately and `WsTransport` owns all reconnection.

- [ ] **Step 1: Disable protocol-internal retry.** Add `Schedule` to the `effect` import list. In `makeProtocolLayer`:

```ts
// The protocol's built-in dial retry is disabled: it would redial forever with
// this session's frozen URL (whose one-time wsToken expires after 5 minutes).
// WsTransport owns reconnection and mints a fresh token per session.
return RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
  Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
);
```

- [ ] **Step 2: Add the probe.** Constants near the top of the class module:

```ts
const CONNECT_PROBE_TIMEOUT_MS = 10_000;
```

Method on `WsTransport`:

```ts
  // A resolved RPC client only proves the plumbing was built — the socket dials
  // lazily. Round-trip a cheap RPC so "open" reflects real connectivity.
  private probeConnection(
    runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>,
    client: RpcClientInstance,
  ): Promise<void> {
    const call = (
      client as unknown as Record<string, (input: unknown) => Effect.Effect<unknown, unknown, never>>
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
```

(`WS_METHODS` is already imported.)

- [ ] **Step 3: Wire into `createSession`.** Replace the `clientPromise` chain with:

```ts
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
```

- [ ] **Step 4: Run existing transport tests:** `bun run test src/wsTransport.test.ts` → PASS (tests dispose before probe timeout matters; MockWebSocket never answers so no test asserts "open").
- [ ] **Step 5: Commit** — `git commit -m "fix(web): confirm socket connectivity before reporting transport open"`

---

### Task 4: Persistent reconnect loop with jittered backoff

**Files:**

- Modify: `apps/web/src/wsTransport.ts` (constructor, `getClient`, `reconnect`, replace `openReconnectSession`, `dispose`)
- Test: `apps/web/src/wsTransport.test.ts`

**Interfaces:**

- Produces:
  - `export function computeReconnectDelayMs(failures: number, random?: () => number): number`
  - `WsTransport.requestReconnectNow(): void` (wakes backoff sleep / starts reconnect; used by Tasks 2, 6, 7)
  - `reconnect()` now resolves only when a session eventually connects (never rejects except on dispose); `getClient()` bounds its wait at 8s.

- [ ] **Step 1: Write failing tests** (append to `wsTransport.test.ts`):

```ts
import { computeReconnectDelayMs } from "./wsTransport"; // merge into existing import

it("computes bounded jittered reconnect delays", () => {
  expect(computeReconnectDelayMs(0, () => 0)).toBe(250);
  expect(computeReconnectDelayMs(0, () => 0.999)).toBeLessThan(500);
  expect(computeReconnectDelayMs(10, () => 0)).toBe(7_500);
  expect(computeReconnectDelayMs(10, () => 0.999)).toBeLessThanOrEqual(15_000);
});

it("keeps retrying failed connections until disposed", async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const resolveUrl = async () => {
      attempts += 1;
      throw new Error("network down");
    };
    const transport = new WsTransport(resolveUrl);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(transport.getState()).toBe("closed");
    transport.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("retries immediately when requestReconnectNow fires during backoff", async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const resolveUrl = async () => {
      attempts += 1;
      throw new Error("network down");
    };
    const transport = new WsTransport(resolveUrl);
    await vi.advanceTimersByTimeAsync(500);
    const before = attempts;
    transport.requestReconnectNow();
    await vi.advanceTimersByTimeAsync(5);
    expect(attempts).toBeGreaterThan(before);
    transport.dispose();
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run** → FAIL (`computeReconnectDelayMs` not exported; single-shot reconnect stops after first failure).

- [ ] **Step 3: Implement.** Constants + helper (module scope):

```ts
const CONNECT_WAIT_TIMEOUT_MS = 8_000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_UNREACHABLE_AFTER_FAILURES = 2;

// Exponential backoff with jitter in [cap/2, cap): concurrent clients spread
// their redials instead of stampeding a just-restarted host.
export function computeReconnectDelayMs(
  failures: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** failures, RECONNECT_MAX_DELAY_MS);
  return Math.round(cap / 2 + random() * (cap / 2));
}
```

Class fields:

```ts
  private reconnectWake: (() => void) | null = null;
  private readonly proactiveTriggerCleanups: Array<() => void> = [];
```

Constructor — after `this.clientPromise = session.clientPromise;` add:

```ts
// The initial connection enters the same persistent retry loop as any drop.
void session.clientPromise.catch(() => {
  if (!this.disposed) void this.reconnect().catch(() => undefined);
});
```

Public wake method:

```ts
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
```

`reconnect()` — mark streams as intentionally stopped (their restart is owned by the loop), drop the `stoppingStreams.clear()`:

```ts
  private reconnect(): Promise<RpcClientInstance> {
    if (this.reconnectPromise) return this.reconnectPromise;

    const oldReady = this.sessionReady;
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
```

Replace `openReconnectSession` with the loop:

```ts
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
```

`getClient()` — bound the wait so user actions fail fast while the loop keeps running:

```ts
  private async getClient(): Promise<RpcClientInstance> {
    try {
      return await this.clientPromise;
    } catch {
      if (this.disposed) throw new Error("Transport disposed");
      return await this.waitForReconnect();
    }
  }

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
```

`dispose()` — first lines become:

```ts
this.disposed = true;
this.setState("disposed");
this.reconnectWake?.();
for (const cleanup of this.proactiveTriggerCleanups) cleanup();
this.proactiveTriggerCleanups.length = 0;
```

Also in `startChannelStream`'s `.catch`, stop the blind 500ms self-poll during outages (the loop restarts every subscribed channel on success):

```ts
      .catch((error) => {
        if (this.disposed || !this.listeners.has(channel)) return;
        console.warn("WebSocket RPC channel failed to start", error);
        if (this.state === "open") {
          setTimeout(() => this.startChannelStream(channel), 500);
        }
      });
```

- [ ] **Step 4: Run** `bun run test src/wsTransport.test.ts` → all PASS.
- [ ] **Step 5: Commit** — `git commit -m "fix(web): replace single-shot ws reconnect with persistent jittered retry loop"`

---

### Task 5: Classify stream failures — resubscribe vs reconnect

**Files:**

- Modify: `apps/web/src/wsTransport.ts` (`startStream` onExit)
- Test: `apps/web/src/wsTransport.test.ts`

**Interfaces:**

- Produces: `export function isConnectionLevelStreamError(error: unknown): boolean`. Server-side stream failures (e.g. `WsRpcError` slow-subscriber resync) restart only that stream; connection-level failures (`RpcClientError`) trigger the transport reconnect loop.

- [ ] **Step 1: Write failing test:**

```ts
import { isConnectionLevelStreamError } from "./wsTransport"; // merge into existing import

it("classifies connection-level stream errors by RpcClientError tag", () => {
  expect(isConnectionLevelStreamError({ _tag: "RpcClientError" })).toBe(true);
  expect(isConnectionLevelStreamError({ _tag: "WsRpcError", message: "resync" })).toBe(false);
  expect(isConnectionLevelStreamError(new Error("boom"))).toBe(false);
  expect(isConnectionLevelStreamError(null)).toBe(false);
});
```

- [ ] **Step 2: Run** → FAIL (not exported).

- [ ] **Step 3: Implement.** Module-scope helper:

```ts
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
```

Rewrite `startStream`'s `onExit` (and add `this.stoppingStreams.delete(key);` right after the `if (this.streamCleanups.has(key)) return;` guard at the top of `startStream`):

```ts
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
```

- [ ] **Step 4: Run** `bun run test src/wsTransport.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "fix(web): restart single failed ws streams instead of tearing down the transport"`

---

### Task 6: Proactive reconnect triggers + request-failure kick

**Files:**

- Modify: `apps/web/src/wsTransport.ts` (constructor, new method, `request`)
- Test: covered by guard behavior in existing tests (stubbed window lacks `addEventListener` → no-op) + Task 4 tests.

**Interfaces:**

- Consumes: `requestReconnectNow()` (Task 4), `isConnectionLevelStreamError` (Task 5).

- [ ] **Step 1: Implement triggers.** New method, called as the LAST line of the constructor:

```ts
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
```

- [ ] **Step 2: Kick reconnect from failed RPCs.** In `request()`, wrap the final call:

```ts
try {
  return (await this.requireRuntime().runPromise(call(normalizedRpcInput))) as T;
} catch (error) {
  // A request failing at the RPC-client layer means the socket died between
  // heartbeats — start reconnecting now rather than waiting for a stream exit.
  if (isConnectionLevelStreamError(error)) this.requestReconnectNow();
  throw error;
}
```

- [ ] **Step 3: Run** `bun run test src/wsTransport.test.ts` → PASS (stubbed window lacks `addEventListener`, guard makes it a no-op).
- [ ] **Step 4: Commit** — `git commit -m "feat(web): redial ws transport on online/visibility/focus and failed RPCs"`

---

### Task 7: In-place retry in HostConnectionBanner

**Files:**

- Modify: `apps/web/src/components/hosts/HostConnectionBanner.tsx`

**Interfaces:**

- Consumes: `requestTransportReconnect` from `../../wsNativeApi` (Task 2/4).

- [ ] **Step 1: Implement.** Import `requestTransportReconnect` and replace the unreachable-state block's copy + Retry button:

```tsx
      <span>Can't reach {active.label}. Retrying automatically…</span>
      <span className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => requestTransportReconnect()}>
          Retry now
        </Button>
```

(Keep the "Switch to Local" button as is. No more `window.location.reload()`.)

- [ ] **Step 2: Run web tests** touching hosts: `bun run test src/hosts` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "fix(web): reconnect in place from the host banner instead of reloading"`

---

### Task 8: Invalidate query caches after reconnect

**Files:**

- Modify: `apps/web/src/routes/__root.tsx` (inside the big effect that owns `unsubWelcome`, ~line 1253; cleanup list ~line 1395-1410)

**Interfaces:**

- Consumes: `addWsTransportStateListener` from `../wsTransportEvents` (add import).

- [ ] **Step 1: Implement.** Next to `unsubWelcome`:

```ts
// Live invalidation events that fired while we were disconnected are gone
// forever. Orchestration state heals via snapshot-on-subscribe, but the
// react-query caches (git status, file trees, provider state) must be
// refetched wholesale after a reconnect.
let transportSawDisconnect = false;
const removeTransportStateListener = addWsTransportStateListener((state) => {
  if (state === "closed" || state === "connecting") {
    transportSawDisconnect = true;
    return;
  }
  if (state === "open" && transportSawDisconnect) {
    transportSawDisconnect = false;
    void queryClient.invalidateQueries();
  }
});
```

In the effect's cleanup return, add `removeTransportStateListener();` alongside `unsubWelcome()`.

- [ ] **Step 2: Typecheck will validate; no dedicated unit test** (the listener helper and the invalidation call are both framework glue; behavior is covered by wsTransportEvents' existing tests).
- [ ] **Step 3: Commit** — `git commit -m "fix(web): refetch query caches after ws reconnect to heal stale panels"`

---

### Task 9: Server TCP keepalive

**Files:**

- Modify: `apps/server/src/effectServer.ts:104-107`

- [ ] **Step 1: Implement:**

```ts
  const httpServer = yield* NodeHttpServer.make(() => {
    nodeServer = http.createServer();
    // Remote clients can vanish without closing TCP (killed mobile browsers,
    // dropped networks). TCP keepalive lets the OS detect dead peers so their
    // websocket subscriptions and buffers are released instead of lingering
    // until the default multi-hour reap.
    nodeServer.on("connection", (socket) => {
      socket.setKeepAlive(true, 30_000);
    });
    return nodeServer;
  }, listenOptions).pipe(
```

- [ ] **Step 2: Run server tests:** `cd apps/server && bun run test src/effectServer* src/serverRuntimeStartup*` (or nearest existing suite) → PASS.
- [ ] **Step 3: Commit** — `git commit -m "fix(server): enable TCP keepalive so half-open ws clients are reaped"`

---

### Task 10: Final verification pass

- [ ] **Step 1:** From repo root: `bun fmt && bun lint && bun typecheck` → all pass (fix anything surfaced).
- [ ] **Step 2:** `bun run test` (workspace) → all pass.
- [ ] **Step 3:** Update `docs/superpowers/specs/2026-07-01-remote-host-connection-reliability-analysis.md` Status line to `Implemented (P0 + P1 items 7/10/11) — 2026-07-01; remaining: server ws-ping, terminal queue bound, revocation socket close, send queue`.
- [ ] **Step 4:** Commit — `git commit -m "docs: mark connection reliability P0 improvements implemented"`

## Self-review notes

- Spec coverage: P0 items 1-6 → Tasks 3-8; P1 heartbeat → Task 9 (TCP keepalive; full ws-ping needs platform-node changes, deferred); P1 auth timeout → Task 1; P1 lazy domain channel → Task 2. Send-queue (P1 #12) intentionally out of scope this pass.
- Type consistency: `requestReconnectNow` (Tasks 2, 4, 6, 7), `isConnectionLevelStreamError` (Tasks 5, 6), `computeReconnectDelayMs` (Task 4) — names match across tasks.
- Ordering: Tasks 1, 2 (lazy part), 3 are independent; Task 2's `requestTransportReconnect` export and Task 7 depend on Task 4. Execute 1 → 3 → 4 → 5 → 6 → 2 → 7 → 8 → 9 → 10 if strict compile-per-commit is desired.
