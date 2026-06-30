# Multi-Host Setup — Design

**Date:** 2026-06-30
**Status:** Approved (design); implementation pending
**Author:** Dylan + Claude (brainstorming session)

## Summary

Let a single Synara client connect to multiple Synara backends ("hosts") and
switch between them. The motivating scenario: an always-on Synara instance on a
Mac Studio that you reach from your laptop's desktop app (while still running
local sessions on the laptop) and from your phone for follow-ups — all over your
own tailnet, with **no dependency on third-party infrastructure** for auth,
session sharing, or transport. Synara owns the entire stack.

## Goals

- One client UI can hold several hosts (e.g. `Local`, `Mac Studio`) and switch
  the **active** host; the whole UI reflects the active host.
- Connect a new client to a remote host via a **pairing link** (with QR
  convenience), built on Synara's existing self-hosted auth.
- Works from the desktop (Electron) app and from a phone browser.
- "Session sharing" falls out for free: laptop and phone pointed at the same
  backend see and resume the same server-side sessions.
- Fully self-owned — only Synara's own auth/transport, scoped to the tailnet.

## Non-goals

- Simultaneous multi-host views / aggregation (one active host at a time).
- Keep-warm connection pools or instant switching (a brief reconnect on switch
  is acceptable).
- Camera-based QR **scanning** in the client (paste-link is the universal path;
  QR is only a host-side generation convenience).
- Tailnet auto-discovery (rejected in favor of explicit pairing links).
- Changing the Local host's auth (loopback stays exactly as today).

## Current state (single-host by design)

- `apps/web/src/wsTransport.ts` — `WsTransport` connects to exactly one backend.
  URL comes from `window.desktopBridge.getWsUrl()`, `VITE_WS_URL`, or page origin.
- `apps/web/src/wsNativeApi.ts` — `createWsNativeApi()` builds a **single global
  transport instance**; the whole app is implicitly scoped to that one server.
- Desktop (Electron) boots a **local** backend and points its window at it.
- Remote access today (`REMOTE.md`): navigate a phone browser to
  `http://<tailnet-ip>:port` — no in-app notion of host A vs host B.
- **Auth is same-origin cookie-based**: `requestAuthJson` calls relative
  `/api/auth/*` paths with `credentials: "same-origin"`, and the WS is served
  from the page origin. → The app can only authenticate to *the host that served
  it*.
- The server-side auth chain we build on already exists:
  - `issuePairingCredential` (owner-only) mints a one-time pairing credential.
  - `exchangeBootstrapCredentialForBearerSession` (`POST /api/auth/bootstrap/bearer`)
    swaps that credential for a **durable, revocable bearer session** (a client).
  - `issueWebSocketToken` (`POST /api/auth/ws-token`) mints a short-lived ws-token
    the socket already accepts via `?token=`.
  - `/api/auth/clients` lists/revokes paired devices.

## Decisions

1. **Core model: switch active host.** One live connection at a time; the whole
   UI reflects the active host. (Rejected: unified/aggregated view; switch +
   side-by-side splits.)
2. **Connect method: pairing link / QR.** Host mints a one-time credential
   encoded in a link; client redeems it for a durable per-device bearer.
   (Rejected: manual URL+token; auto-discovery; host-side approval.)
3. **Host runtime: works headless and in the GUI.** A shared `PairingService`
   backs a CLI command, a served page, and the desktop GUI.
4. **Implementation shape: rebuild-on-switch (Approach 1).** Keep one transport +
   native-API at a time; on switch, tear down and rebuild pointed at the new
   host. Smallest blast radius for a large single-host codebase. (Rejected:
   keep-warm pool; reload-the-webview.)
5. **Local host stays on loopback.** Only remote hosts use the new bearer path —
   zero regression risk on the most-common path.
6. **Paste-link is first-class on every client** (desktop and mobile). QR is a
   host-side convenience only.

## Architecture

### Client-side concepts

**`Host` record** (persisted per device):

- `id` — stable client-generated UUID
- `label` — user-facing ("Mac Studio", "Local")
- `kind` — `"local"` | `"remote"`
- `baseUrl` — absolute origin for remote (`https://mac-studio.ts.net:3773`); for
  desktop local, the bridge URL
- `serverIdentity` — optional stable server-issued id + name (reuses the existing
  server-identity behind `LocalServerIdentity`), used to detect "same host, new
  URL" and to auto-label
- `createdAt`, `lastConnectedAt`

**`activeHostId`** — single persisted pointer; the whole UI reflects this host.

**Credential per host** — durable bearer from pairing, stored **separately** from
the host record, secured by the client:

- Desktop → OS keychain via Electron `safeStorage` (through the bridge)
- Browser / phone → `localStorage` (tailnet-scoped, individually revocable token)

**The "Local" host** (desktop only): always present, pinned, non-removable, no
pairing required (loopback trust via the existing desktop bridge path). On a
phone there is no local host — the list is purely remote.

**App-shell origin vs active host can differ.** The desktop bundles the web app
and connects out to any host. The phone loads the web app *from* a host (its
shell origin = that host). Both are handled uniformly by the bearer model.

### Auth: same-origin cookie → per-host bearer (remote only)

- Introduce a `HostConnection` context `{ baseUrl, authHeader() }` threaded into
  the auth client and the transport. It **branches on `host.kind`**:
  - `local` → delegates to the current loopback / same-origin code path,
    unchanged.
  - `remote` → absolute URL + `Authorization: Bearer <host credential>`.
- `requestAuthJson(path, …)` → `requestAuthJson(host, path, …)`: for remote, hits
  `host.baseUrl + path` with the bearer header instead of
  `credentials: "same-origin"`.
- **WS transport** gets `{ baseUrl }`. Before connecting it calls
  `issueAuthWebSocketToken()` (bearer-authed) for a short-lived ws-token, then
  opens `wss://<host>/ws?token=<wsToken>`. On reconnect it re-issues. The durable
  bearer never travels on the socket URL — only the ephemeral ws-token does.
- **Server CORS:** add cross-origin support on the auth/RPC HTTP routes for the
  bearer path, with `Access-Control-Allow-Headers: Authorization`. Safe because
  there are no ambient cookies to ride along (no
  `Access-Control-Allow-Credentials`). The local loopback path is unaffected; the
  WS upgrade is not subject to CORS and is gated by the ws-token.

### Pairing: one link format, two consumption paths

A pairing link is an **https deep link to the host** with the one-time credential
in the URL **fragment** (fragments are not sent to servers / not logged):

```
https://mac-studio.ts.net:3773/pair#c=<one-time-credential>
```

The origin *is* the host's `baseUrl`; the fragment carries the credential.

- **Phone:** scans QR (or taps/pastes the link) → browser opens the URL → the
  host serves the web app's new `/pair` route → it reads the fragment and redeems
  **same-origin** → stores bearer → sets active host = that host → boots.
- **Any client (incl. desktop & mobile):** "Add host" modal parses a pasted link
  → redeems **cross-origin** (`POST baseUrl/api/auth/bootstrap/bearer`, CORS) →
  stores bearer → saves host.

Redemption maps directly onto `exchangeBootstrapCredentialForBearerSession`. A new
web route `/pair` is added (SPA fallback already serves it).

### Pairing generation surfaces (shared `PairingService` over `issuePairingCredential`)

- **CLI:** `synara pair [--label] [--expires 10m]` — authorized via
  **loopback = owner** (consistent with the Local decision); prints the link, the
  MagicDNS URL, and a terminal QR (plus optional PNG).
- **Served page:** `GET /pair/new` (owner-authed) renders QR + link, so any
  already-authed device can mint one.
- **Desktop GUI:** Settings → Devices → "Add a device" renders the same QR + link.

### Client UI

1. **Host switcher** — sidebar header: active host label + status dot
   (connected / connecting / unreachable). Dropdown lists Local (pinned) +
   remotes, each with status, plus "Add host…" and "Manage devices…". Selecting →
   rebuild-on-switch.
2. **Add host** — modal: "Paste link" (universal, all clients) → validate →
   redeem → save. (Optional "Scan QR" is out of scope; QR is generation-only.)
3. **Manage devices** (this host) — Settings → Devices: generate pairing link
   (QR + copyable link) + list paired clients from `/api/auth/clients` with
   revoke. Reuses existing endpoints.
4. **Connection status** — non-blocking banner when the active host is
   unreachable, with retry + "switch host."

### Rebuild-on-switch lifecycle

On `activeHostId` change:

1. Dispose the current `WsTransport` and drop the native-API singleton
   (`instance = null`).
2. Reset all host-scoped stores (projects, threads, terminals, …) to empty.
3. Build the new connection: **local** → existing loopback path; **remote** →
   ensure bearer present → fetch ws-token → construct transport with `baseUrl` +
   token.
4. Re-run the existing init subscriptions (welcome / config / providers /
   settings), now host-parameterized.
5. UI shows "Connecting to <host>"; renders on welcome.

Switching away **never stops** the other host's server-side sessions — agents
keep running per-backend, so switching back just re-subscribes to live state.
This is what makes "session sharing" free.

## Reliability / failure behavior (predictable, never silent)

- **Unreachable active host:** reuse the transport's existing exp-backoff
  reconnect (500 ms → 5 s); surface as an "unreachable" status dot + non-blocking
  banner (retry / switch host). Never spin silently.
- **ws-token expiry / 401 on reconnect:** re-issue ws-token from the stored
  bearer automatically.
- **Bearer revoked** (device removed): connect fails auth → mark host
  "needs re-pair," prompt to re-add; don't loop. Desktop can fall back to Local.
- **Bad/expired pairing link on redeem:** clear inline error in the Add-host
  modal.
- **Boot:** restore the last active host; if a remote is unreachable, still boot
  to the switcher in "connecting/unreachable" state — never hard-block the app.

## Security

- **Host metadata + `activeHostId`:** persisted store (localStorage).
- **Bearer credential:** desktop → OS keychain via `safeStorage`; mobile/web →
  localStorage. Per-device, individually revocable via `/api/auth/clients`.
- **ws-tokens** are short-lived; the durable bearer never rides the socket URL.
- **CORS** is permissive on bearer routes only (no ambient credentials), with
  `Authorization` allowed.
- **Trust boundary stays the tailnet:** hosts bind to tailnet / loopback (not
  public `0.0.0.0`); the bearer is defense-in-depth.

## Testing (Vitest via `bun run test` — never `bun test`)

- **Unit:** `HostConnection` auth selection (local vs remote), pairing-link parse
  (origin + fragment), credential-store abstraction (keychain / localStorage),
  rebuild-on-switch store reset.
- **Transport:** ws-token fetch + attach, reconnect re-issues token, revoked
  bearer → "needs re-pair" (extends `wsTransport.test.ts`, reuses
  `effectRpcWebSocketMock`).
- **Server:** `bootstrap/bearer` redeem (happy + expired/invalid), CORS preflight
  on bearer routes, loopback-owner for `synara pair`, pairing-link format.
- **Final verification pass:** `bun fmt`, `bun lint`, `bun typecheck`.

## Affected areas (orientation for the plan)

- `apps/web/src/wsTransport.ts`, `apps/web/src/wsNativeApi.ts` — host-parameterize
  transport + auth client.
- New client modules: host store (`Host` list + `activeHostId`), credential store
  abstraction, `HostConnection`, host switcher + Add-host UI, `/pair` route,
  Settings → Devices.
- `apps/server/src/auth/http.ts` + auth services — CORS on bearer routes; shared
  `PairingService`; `/pair/new` served page.
- New CLI: `synara pair` (loopback-owner).
- Desktop: `safeStorage` credential bridge; the Local host wiring.

## Rollout / sequencing (high level — detailed plan to follow)

1. Server: CORS for bearer routes + verify `bootstrap/bearer` redeem end to end.
2. Client auth/transport: `HostConnection`, host-aware `requestAuthJson` + WS
   ws-token attach (remote path), with Local unchanged.
3. Host store + rebuild-on-switch lifecycle + store resets.
4. Pairing: `/pair` redeem route, Add-host paste-link, `PairingService`,
   `synara pair` CLI, `/pair/new` page, desktop GUI generation.
5. UI: host switcher, connection status, Manage devices.
6. Hardening: failure states (revoked / unreachable / expired), tests, docs
   (update `REMOTE.md`).
