# Remote Host Connection Reliability — Deep Analysis

Date: 2026-07-01
Status: Implemented (P0 + P1 items 7/10/11) — 2026-07-01; remaining: server ws-ping (needs platform-node socket access; TCP keepalive shipped instead), terminal queue bound, revocation socket close, send queue
Symptoms reported: remote host connections cut out easily; UI state gets desynced after drops.

## Architecture summary (as-built)

One multiplexed WebSocket at `/ws` carries every RPC call and every subscription stream
(Effect RPC, JSON serialization). Remote hosts authenticate with a 30-day bearer credential
(localStorage on web, keychain on desktop), exchanged per-connection for a 5-minute HMAC
`wsToken` via `POST /api/auth/ws-token`, appended to the socket URL.

- Client transport: `apps/web/src/wsTransport.ts` (`WsTransport`) on top of Effect's
  `RpcClient.layerProtocolSocket` + `Socket.layerWebSocket`.
- Server: `apps/server/src/wsRpc.ts` route `GET /ws` → `RpcServer.toHttpEffectWebsocket`,
  Node `http` + `ws` lib (all defaults; `noServer: true`, no idle timeout, maxPayload 100 MiB).
- Streams are snapshot-then-live for shell / thread-detail / config / settings / providers /
  lifecycle / dev-servers / automation (`wsRpc.ts:622-695`, etc). Events are durably
  sequenced; client-driven gap recovery exists via `replayEvents(fromSequenceExclusive)`
  (`wsRpc.ts:610-621`).
- Per-subscriber sliding buffer (capacity 1024, drops oldest) with an intentional
  recovery design: on overflow the stream FAILS so the client resubscribes and gets a fresh
  snapshot (`apps/server/src/wsStreamBackpressure.ts`, `failLiveUiStreamForSnapshotResync`
  usages in `wsRpc.ts`).
- Effect's RPC protocol has a built-in app-level heartbeat: client sends `{_tag:"Ping"}`
  every 5s, kills the connection on missed pong (`RpcClient.js` `makePinger`); server replies
  Pong (`RpcServer.js:444-446`) but never initiates pings.

The design bones are good: sequenced durable events, snapshot-on-subscribe, bounded buffers
with resync-on-overflow, client heartbeat. The failures are in the connection lifecycle
layer that ties it together.

## Root causes, ranked by contribution to symptoms

### R1 — Reconnect gives up after a single failed attempt (client)

`wsTransport.ts` `openReconnectSession()` makes exactly one attempt per trigger. The trigger
is a stream-failure exit; on reconnect failure every waiter does `.catch(console.warn)` and
nothing schedules another attempt (`wsTransport.ts:561-572`, `348-368`). For a remote host,
the attempt starts with the `ws-token` POST — which fails while the network is still down
(the attempt fires 0–500ms after the drop, when the network is almost certainly still down).
Result: transport permanently dead until an incidental RPC call happens to run `getClient()`
or the user presses "Retry" — which is a full `window.location.reload()`
(`HostConnectionBanner.tsx:57`). This is the primary "cuts out and stays out".

### R2 — Any single stream failure triggers full-transport teardown (client)

`startStream`'s onExit path calls `this.reconnect()` unconditionally for every failed stream
(`wsTransport.ts:561-572`). But the server fails individual streams _on purpose_ as its
slow-consumer recovery (buffer overflow → fail → expect resubscribe). The client responds to
"one stream needs a resubscribe" by tearing down the socket, disposing the runtime,
re-minting a wsToken, and re-subscribing all ~9 channels + every thread stream. During busy
turns on higher-RTT links (acks pace chunk delivery; the 1024-slot sliding buffer can
overflow under sustained bursts) this produces reconnect/resync storms that look exactly
like "the connection cuts out". Localhost never sees this — RTT ≈ 0.

### R3 — No proactive reconnect triggers (client)

Nothing listens to `online`, `visibilitychange`, `pageshow`, or `focus` to check/redial the
socket. Mobile browsers kill background sockets; on return the app waits passively for
failure detection instead of redialing immediately. (The only accidental trigger is
`useProviderStatusRefresh` with `refreshOnFocus`, where mounted, via its RPC call.)

### R4 — Connection status can lie (client)

`setState("open")` fires when the RPC _client object_ is created, not when the socket
actually connects — Effect's socket `writer` is acquired without awaiting connection, and
the protocol's run loop is forked with its own infinite internal retry. So the banner can
show "connected" while nothing flows, and there is no "reconnecting" state driven by real
socket lifecycle. Users experience this as silent desync.

### R5 — Two competing reconnect layers + stale baked-in token (client)

`makeProtocolLayer(url)` bakes the URL — including the one-shot-ish, 5-minute wsToken — into
the socket layer. Effect's protocol internally retries the dial forever with that same URL
(`defaultRetryPolicy` exp 500ms→5s). After the connection has been up >5 minutes, any drop
means every internal redial presents an expired token and gets 403'd; escape depends on
R1's fragile single-shot app-level path. Two reconnect mechanisms race and thrash.
Note: `Socket.makeWebSocket` accepts an _Effect_ for the URL — a fresh-token-per-dial hook
exists upstream and is unused.

### R6 — Reconnect doesn't heal derived/query state (client)

Orchestration state self-heals via snapshot-on-subscribe, but react-query caches (git
status, file trees, diffs, provider state) are invalidated by live events; invalidations
missed during a gap are lost forever, and nothing does a blanket invalidate on reconnect.
Stale side panels after a blip = "UI state desynced".

### R7 — No server-side liveness detection (server)

No `ws.ping`, no pong timeout, no TCP keepalive; the server is a pure Pong responder.
Silently-dead clients (killed phone process, frozen tab) leave half-open sockets whose
subscription fibers and buffers linger until OS TCP reap. The terminal stream's
per-connection queue is unbounded (lossless by design, `wsRpc.ts:905-915`) — the one true
unbounded-growth spot. Also: revoking a session does not close its live socket.

### R8 — Sends fail hard during blips (client)

`dispatchCommand` and friends are fire-and-fail; no queue, no retry, no "disabled while
reconnecting" state. On flaky links, user actions error out unpredictably.

### R9 — No timeout on the auth fetch (client)

`hostConnection.requestAuthJson` (`hostConnection.ts:98`) has no AbortController; a
black-holed network can hang the ws-token POST for the browser default (~75s+), pinning the
transport in "connecting" limbo.

### R10 — Dead-weight domain-event channel (both)

Every client eagerly subscribes to `orchestration.domainEvent` (`wsNativeApi.ts:397`) —
which streams **every** domain event over the wire — yet no production code registers a
consumer. Server-side this channel is the only one with no snapshot and no drop-recovery
(`wsRpc.ts:697-700`): a latent silent-desync trap plus real bandwidth waste on remote links.

### R11 — Smaller items

- `latestPushByChannel` replays stale pre-disconnect data to late subscribers after
  reconnect (`wsTransport.ts:219-236`); never cleared on session swap.
- `/ws` session auth + connect/disconnect tracking only run when legacy `config.authToken`
  is set (`wsRpc.ts:1263-1276`); default pairing deployments get origin-gate/wsToken only.
- The whole transport rides a beta snapshot (`effect-smol` `4.0.0-beta.25` via pkg.pr.new).
- `maxPayload` at the `ws` default 100 MiB; oversize inbound frame hard-closes (1009).

## Improvement plan (prioritized)

### P0 — Connection lifecycle overhaul (`wsTransport.ts`, mostly client)

1. **Persistent reconnect loop.** Retry with exponential backoff + jitter until success or
   dispose (cap ~15–30s); reset backoff on success. Never single-shot.
2. **Proactive triggers.** Immediate reconnect attempt (bypassing backoff) on `online`,
   `visibilitychange→visible`, `pageshow`, `focus`.
3. **Stream failure ≠ connection failure.** Resubscribe just the failed stream when the
   socket is healthy; only tear down the transport on protocol/socket-level failure. This
   makes the server's overflow-resync design work as intended.
4. **One reconnect owner + fresh token per dial.** Either pass an Effect URL to
   `Socket.layerWebSocket` that mints a fresh wsToken per dial, or set a fail-fast
   `retryPolicy` on `layerProtocolSocket` so the app layer owns all reconnects. Not both
   layers.
5. **Truthful state machine.** Derive `connecting/open/reconnecting/closed` from actual
   socket lifecycle; banner shows "reconnecting…"; "Retry" = in-place reconnect, not reload.
6. **Resync on reconnect.** On open-after-drop: re-run scoped subscriptions (already mostly
   automatic via snapshot-on-subscribe) + blanket `queryClient.invalidateQueries()`.

### P1 — Server liveness + protocol hygiene

7. **Server heartbeat.** `ws.ping` every ~30s, terminate after 2 missed pongs (and/or
   `socket.setKeepAlive`). Closes half-open sockets, frees subscriptions/queues promptly.
8. **Bound the terminal queue** per connection; define drop/refit semantics for dead-slow
   subscribers.
9. **Close sockets on session revoke** (live revocation, not just next-connect).
10. **Timeout the auth fetch** (AbortController ~10s) and treat upgrade-403 as
    "mint new token and retry", reserving needs-repair for real 401 revocations.
11. **Fix or remove the raw domain-event channel:** make the eager subscription lazy (only
    when a listener registers), and if kept, give it snapshot/cursor recovery like the rest.
12. **Send resilience.** Preserve composer drafts on failed sends; disable send with clear
    affordance while reconnecting; optionally queue idempotent commands for auto-retry.

### P2 — Hardening + observability

13. Reconnect/drop telemetry in `serverGetDiagnostics` + client console: reconnect counts,
    stream-failure causes, buffer-overflow reports (server already logs `[ws-stream]` warns).
14. Session-level auth/tracking on `/ws` in pairing deployments (`wsRpc.ts:1263`).
15. Sane `maxPayload`; evaluate `perMessageDeflate` for remote links.
16. Chaos-style integration tests (`apps/server/integration`): kill socket mid-turn,
    unreachable ws-token endpoint, background/foreground cycles, slow-consumer overflow.

## Verification notes

- Client behavior verified against vendored `effect` 4.0.0-beta.25 sources
  (`RpcClient.js` makeProtocolSocket/makePinger/defaultRetryPolicy; `Socket.js`
  makeWebSocket/fromWebSocket; `RpcServer.js` Ping→Pong and ack-gated chunk streaming).
- Server behavior verified in `wsRpc.ts`, `wsStreamBackpressure.ts`, `effectServer.ts`,
  `auth/Layers/SessionCredentialService.ts` (ws-token TTL 5min, HMAC, not single-use;
  bearer TTL 30d).
- Turns keep running server-side across drops; state is recoverable — the gaps are in
  detection, redial persistence, and derived-cache resync, not in event durability.
