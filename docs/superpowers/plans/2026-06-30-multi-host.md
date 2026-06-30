# Multi-Host Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Synara client hold several hosts (Local + remote-over-tailnet) and switch the active host, connecting to a remote host via a paste-able pairing link, with no third-party infrastructure.

**Architecture:** Rebuild-on-switch — one live transport + native-API at a time; switching disposes the current transport, resets host-scoped stores, and rebuilds against the new host. The Local host keeps the existing loopback/same-origin path untouched; remote hosts use a per-host bearer credential (from the existing pairing chain) plus a short-lived `wsToken` on the socket. Server gains cross-origin CORS response headers for already-trusted app origins; the latent `issueStartupPairingUrl` is wired up for a headless pairing surface.

**Tech Stack:** TypeScript, Effect (HttpRouter / RpcClient / Schema), React + TanStack Router (file-based codegen), Zustand (`persist`), Base UI primitives, Electron (`safeStorage`), Vitest. Package manager: `bun`.

## Global Constraints

- Run tests with `bun run test` (Vitest). **NEVER** run `bun test`.
- Final verification per task batch: `bun fmt`, `bun lint`, `bun typecheck` must pass. Treat these as one bundled final pass; don't rerun repeatedly mid-iteration.
- Commit messages and PR bodies: **no Claude/AI attribution** of any kind (no `Co-Authored-By`, no session trailer, no "Generated with").
- `packages/contracts` is schema-only — no runtime logic.
- `packages/shared` uses explicit subpath exports — no barrel index.
- Reuse the shared disclosure motion (`apps/web/src/lib/disclosureMotion.ts`) for any open/close animation; never write bespoke toggle transitions.
- The Local host's auth path must remain byte-for-byte unchanged; all new behavior is gated to `kind === "remote"`.
- Pairing link format is fixed: `<baseUrl>/pair#token=<credential>` (fragment param name `token`), matching `issueStartupPairingUrl`.
- WS session-token query param is `wsToken` (the legacy `token` param belongs to `--auth-token` and must not be reused).
- Trusted app origins are governed by `apps/server/src/trustedOrigins.ts`; the desktop origin constant is `DESKTOP_APP_CORS_ORIGIN = "t3://app"`.

---

## Phase A — Server: cross-origin CORS for trusted app origins

The desktop renderer runs at origin `t3://app`, already trusted by `isTrustedAppOrigin` and the WS origin gate. Cross-origin `fetch` (desktop → remote host) still needs CORS **response** headers + an OPTIONS preflight short-circuit on `/api/auth/*`. WS needs no change (not subject to CORS; origin gate already passes `t3://app`).

### Task A1: Reusable app-CORS header helper

**Files:**
- Create: `apps/server/src/appCors.ts`
- Test: `apps/server/src/appCors.test.ts`

**Interfaces:**
- Consumes: `isTrustedAppOrigin`, `normalizeCorsOrigin` from `./trustedOrigins`; `ServerConfigShape` from `./config`.
- Produces:
  - `appCorsHeaders(input: { rawOrigin: string | ReadonlyArray<string> | undefined; requestOrigin: string; config: ServerConfigShape }): Record<string, string>` — returns `{}` when the origin is not trusted, otherwise the ACAO/Vary/ACAM/ACAH set.
  - `CORS_ALLOWED_METHODS = "GET, POST, OPTIONS"`, `CORS_ALLOWED_HEADERS = "Authorization, Content-Type"`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/server/src/appCors.test.ts
import { describe, expect, it } from "vitest";

import { appCorsHeaders } from "./appCors";
import type { ServerConfigShape } from "./config";

const config = { host: "0.0.0.0", mode: "web" } as unknown as ServerConfigShape;

describe("appCorsHeaders", () => {
  it("emits CORS headers for the trusted desktop origin", () => {
    const headers = appCorsHeaders({
      rawOrigin: "t3://app",
      requestOrigin: "https://studio.tailnet.ts.net:3773",
      config,
    });
    expect(headers["Access-Control-Allow-Origin"]).toBe("t3://app");
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(headers.Vary).toBe("Origin");
  });

  it("returns no headers for an untrusted origin", () => {
    const headers = appCorsHeaders({
      rawOrigin: "https://evil.example.com",
      requestOrigin: "https://studio.tailnet.ts.net:3773",
      config,
    });
    expect(headers).toEqual({});
  });

  it("returns no headers when no Origin is present", () => {
    expect(
      appCorsHeaders({ rawOrigin: undefined, requestOrigin: "https://x", config }),
    ).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/server/src/appCors.test.ts`
Expected: FAIL — `Cannot find module './appCors'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/server/src/appCors.ts
// FILE: appCors.ts
// Purpose: Cross-origin response headers for trusted Synara app surfaces
//          (e.g. the desktop app at t3://app connecting to a remote host).
// Layer: Server HTTP/security utility
// Exports: appCorsHeaders, CORS_ALLOWED_METHODS, CORS_ALLOWED_HEADERS

import type { ServerConfigShape } from "./config";
import { isTrustedAppOrigin, normalizeCorsOrigin } from "./trustedOrigins";

export const CORS_ALLOWED_METHODS = "GET, POST, OPTIONS";
export const CORS_ALLOWED_HEADERS = "Authorization, Content-Type";

export function appCorsHeaders(input: {
  readonly rawOrigin: string | ReadonlyArray<string> | undefined;
  readonly requestOrigin: string;
  readonly config: ServerConfigShape;
}): Record<string, string> {
  const origin = normalizeCorsOrigin(input.rawOrigin);
  if (!origin || origin === input.requestOrigin) {
    // Missing origin, or same-origin requests, need no CORS headers.
    return {};
  }
  if (!isTrustedAppOrigin({ origin, requestOrigin: input.requestOrigin, config: input.config })) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    Vary: "Origin",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/server/src/appCors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/appCors.ts apps/server/src/appCors.test.ts
git commit -m "feat(server): add app-CORS header helper for trusted origins"
```

### Task A2: Apply CORS + OPTIONS preflight to `/api/auth/*`

**Files:**
- Modify: `apps/server/src/http.ts` (the `authEffectRouteLayer`, ~line 209–374; imports ~line 34)
- Test: `apps/server/src/http.test.ts` (existing — add cases)

**Interfaces:**
- Consumes: `appCorsHeaders` (Task A1).
- Produces: every `/api/auth/*` response carries CORS headers for trusted cross-origins; an `OPTIONS /api/auth/*` returns `204` with CORS headers.

- [ ] **Step 1: Write the failing test** — add to `apps/server/src/http.test.ts`

```typescript
it("answers OPTIONS preflight on auth routes with CORS headers for t3://app", async () => {
  const response = await callAuthRoute({
    method: "OPTIONS",
    path: "/api/auth/session",
    headers: { origin: "t3://app" },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("t3://app");
  expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
});

it("includes CORS headers on GET /api/auth/session for t3://app", async () => {
  const response = await callAuthRoute({
    method: "GET",
    path: "/api/auth/session",
    headers: { origin: "t3://app" },
  });
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("t3://app");
});
```

> Use the existing `http.test.ts` harness for constructing requests. If a `callAuthRoute` helper does not already exist, add a thin wrapper around the same request-building utility the file already uses (mirror an existing test in this file — copy its setup verbatim and change method/path/headers).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/server/src/http.test.ts`
Expected: FAIL — no `Access-Control-Allow-Origin` header; OPTIONS not handled (likely 404/405).

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/http.ts`, add the import near line 34:

```typescript
import { appCorsHeaders } from "./appCors";
```

Inside the `authEffectRouteLayer` generator, immediately after `const authRequest = makeEffectAuthRequest(request);` and the `url` guard, compute CORS headers and short-circuit preflight:

```typescript
const cors = appCorsHeaders({
  rawOrigin: request.headers.origin,
  requestOrigin: url.origin,
  config,
});

if (request.method === "OPTIONS") {
  return HttpServerResponse.empty({ status: 204, headers: cors });
}
```

Then ensure each JSON/text response in this route includes `cors`. The route builds responses via the local `respondJson` / `HttpServerResponse.*`. Add `headers: cors` (merged with any existing headers) to the responses. The simplest robust approach: wrap the route's returned response once at the end. If the route returns a single `HttpServerResponse`, attach headers at the return site using `HttpServerResponse.setHeaders(cors)`:

```typescript
// At each `return HttpServerResponse.jsonUnsafe(...)`/`respondJson` return point in this
// layer, pipe through: .pipe(HttpServerResponse.setHeaders(cors))
// e.g.:
return HttpServerResponse.jsonUnsafe(yield* serverAuth.getSessionState(authRequest)).pipe(
  HttpServerResponse.setHeaders(cors),
);
```

> Apply `HttpServerResponse.setHeaders(cors)` to ALL response return points within `authEffectRouteLayer`, including the `AuthError` catch handler (`authErrorResponse(error)`). Verify `HttpServerResponse.setHeaders` and `HttpServerResponse.empty` exist in the installed `effect/unstable/http`; if the exact names differ, use the equivalent header-merge + empty-body constructors from that module (grep the module's exports).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/server/src/http.test.ts`
Expected: PASS, including the two new cases and all pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http.ts apps/server/src/http.test.ts
git commit -m "feat(server): emit CORS + preflight on auth routes for trusted origins"
```

---

## Phase B — Server: headless pairing surface

Wire the latent `issueStartupPairingUrl` so an always-on headless host can surface a pairing link + QR, and add a served owner-only `/api/auth/pairing-url` convenience that returns a ready-to-use link (the GUI reuses the existing `pairing-token` endpoint).

### Task B1: Print pairing URL + terminal QR at startup when remote-reachable

**Files:**
- Modify: `apps/server/src/main.ts` (the `makeServerProgram` startup path)
- Create: `apps/server/src/startupPairingBanner.ts`
- Test: `apps/server/src/startupPairingBanner.test.ts`
- Modify: `apps/web/package.json` is NOT involved here; add `qrcode` to `apps/server/package.json` dependencies.

**Interfaces:**
- Consumes: `ServerAuth.issueStartupPairingUrl(baseUrl)`; `qrcode` (`QRCode.toString`).
- Produces: `formatStartupPairingBanner(input: { pairingUrl: string; qr: string }): string` — pure string formatter; and a startup side-effect that logs it.

- [ ] **Step 1: Add the dependency**

```bash
cd /Users/dylan/dev/synara
bun add --cwd apps/server qrcode
bun add --cwd apps/server -d @types/qrcode
```

- [ ] **Step 2: Write the failing test**

```typescript
// apps/server/src/startupPairingBanner.test.ts
import { describe, expect, it } from "vitest";

import { formatStartupPairingBanner } from "./startupPairingBanner";

describe("formatStartupPairingBanner", () => {
  it("includes the pairing URL and the QR block", () => {
    const banner = formatStartupPairingBanner({
      pairingUrl: "https://studio.ts.net:3773/pair#token=ABCD1234WXYZ",
      qr: "█▀▀▀▀▀█",
    });
    expect(banner).toContain("https://studio.ts.net:3773/pair#token=ABCD1234WXYZ");
    expect(banner).toContain("█▀▀▀▀▀█");
    expect(banner).toContain("Pair a device");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test apps/server/src/startupPairingBanner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```typescript
// apps/server/src/startupPairingBanner.ts
// FILE: startupPairingBanner.ts
// Purpose: Format the headless pairing banner (link + QR) shown at startup.
// Layer: Server startup utility
// Exports: formatStartupPairingBanner, renderPairingQr

import QRCode from "qrcode";

export function formatStartupPairingBanner(input: {
  readonly pairingUrl: string;
  readonly qr: string;
}): string {
  return [
    "",
    "  Pair a device with this Synara host:",
    "",
    input.qr,
    `  ${input.pairingUrl}`,
    "",
    "  Open the link on the device, or paste it into Add host. Expires shortly.",
    "",
  ].join("\n");
}

export function renderPairingQr(pairingUrl: string): Promise<string> {
  return QRCode.toString(pairingUrl, { type: "terminal", small: true });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test apps/server/src/startupPairingBanner.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire it into startup**

In `apps/server/src/main.ts`, inside `makeServerProgram`, after the server is listening and the auth policy is known, emit the banner only when the policy is `remote-reachable` (don't spam loopback-only/desktop-managed runs). Add near the existing startup logging:

```typescript
// After the HTTP server is listening:
const descriptor = yield* serverAuth.getDescriptor();
if (descriptor.policy === "remote-reachable") {
  const baseUrl = resolvePublicBaseUrl(config); // existing host+port -> URL helper; if none, build `http(s)://${host}:${port}`
  const pairingUrl = yield* serverAuth.issueStartupPairingUrl(baseUrl);
  const qr = yield* Effect.promise(() => renderPairingQr(pairingUrl));
  yield* Effect.logInfo(formatStartupPairingBanner({ pairingUrl, qr }));
}
```

Add the imports at the top of `main.ts`:

```typescript
import { formatStartupPairingBanner, renderPairingQr } from "./startupPairingBanner";
```

> `resolvePublicBaseUrl(config)`: if a helper for host+port→URL already exists in the server, use it; otherwise construct `` `http://${config.host}:${config.port}` `` (use `https` only if the server terminates TLS — Synara binds plain HTTP behind the tailnet, so `http` is correct here). Grep `main.ts` for the existing "listening on" log to find the already-computed address and reuse it.

- [ ] **Step 7: Verify build + run the targeted test again**

Run: `bun run test apps/server/src/startupPairingBanner.test.ts`
Expected: PASS. (Full server boot is validated in the final verification pass.)

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/startupPairingBanner.ts apps/server/src/startupPairingBanner.test.ts apps/server/src/main.ts apps/server/package.json package.json bun.lock
git commit -m "feat(server): print pairing link + QR at startup when remote-reachable"
```

### Task B2: Owner-only `/api/auth/pairing-url` endpoint (ready-made client link)

**Files:**
- Modify: `apps/server/src/auth/http.ts` (add a route near the existing `/api/auth/pairing-token`, ~line 268)
- Modify: `apps/server/src/auth/Services/ServerAuth.ts` (add method to shape) and `apps/server/src/auth/Layers/ServerAuth.ts` (implement)
- Test: `apps/server/src/auth/Layers/ServerAuth.test.ts` (existing — add case)

**Interfaces:**
- Produces: `ServerAuth.issueClientPairingUrl(baseUrl: string, input?: AuthCreatePairingCredentialInput): Effect<string, AuthError>` — like `issueStartupPairingUrl` but role `client`; and `POST /api/auth/pairing-url` (owner-authed) returning `{ url: string; expiresAt: string }`.

- [ ] **Step 1: Write the failing test** — add to `apps/server/src/auth/Layers/ServerAuth.test.ts`

```typescript
it("issues a client pairing URL with the /pair#token fragment", async () => {
  await Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const url = yield* serverAuth.issueClientPairingUrl("http://127.0.0.1:3773");
    expect(url).toContain("http://127.0.0.1:3773/pair#token=");
  }).pipe(/* provide the same test layer the sibling tests use */);
});
```

> Copy the exact layer-provision boilerplate from the adjacent `issueStartupPairingUrl` test in this file (lines ~109, ~137, ~182) rather than inventing it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/server/src/auth/Layers/ServerAuth.test.ts`
Expected: FAIL — `issueClientPairingUrl` is not a function.

- [ ] **Step 3: Implement the method**

In `apps/server/src/auth/Services/ServerAuth.ts`, add to `ServerAuthShape`:

```typescript
readonly issueClientPairingUrl: (
  baseUrl: string,
  input?: AuthCreatePairingCredentialInput,
) => Effect.Effect<string, AuthError>;
```

In `apps/server/src/auth/Layers/ServerAuth.ts`, implement next to `issueStartupPairingUrl`:

```typescript
const issueClientPairingUrl: ServerAuthShape["issueClientPairingUrl"] = (baseUrl, input) =>
  issuePairingCredential({ ...(input ?? {}), role: "client" }).pipe(
    Effect.map((issued) => {
      const url = new URL(baseUrl);
      url.pathname = "/pair";
      url.searchParams.delete("token");
      url.hash = new URLSearchParams([["token", issued.credential]]).toString();
      return url.toString();
    }),
  );
```

Add `issueClientPairingUrl` to the returned object (next to `issueStartupPairingUrl`).

- [ ] **Step 4: Add the HTTP route** — in `apps/server/src/auth/http.ts`, after the `/api/auth/pairing-token` handler (~line 295):

```typescript
if (method === "POST" && input.url.pathname === "/api/auth/pairing-url") {
  const session = yield* input.serverAuth.authenticateHttpRequest(authRequest);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can create pairing links.",
      status: 403,
    });
  }
  const payload = hasRequestBody(headers)
    ? yield* readJsonBody(input.req, "Invalid pairing url payload.").pipe(
        Effect.flatMap((body) =>
          decodeCreatePairingCredentialInput(body).pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({ message: "Invalid pairing url payload.", status: 400, cause }),
            ),
          ),
        ),
      )
    : {};
  const baseUrl = `${input.url.protocol}//${input.url.host}`;
  const url = yield* input.serverAuth.issueClientPairingUrl(baseUrl, payload);
  respondJson(input.respond, 200, { url });
  return;
}
```

> Mirror the registration in `apps/server/src/http.ts` if that file maintains a parallel route list (it has a sibling `/api/auth/pairing-token` block around line 274 — add the matching block there too, returning the same shape).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test apps/server/src/auth/Layers/ServerAuth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth/Services/ServerAuth.ts apps/server/src/auth/Layers/ServerAuth.ts apps/server/src/auth/http.ts apps/server/src/http.ts apps/server/src/auth/Layers/ServerAuth.test.ts
git commit -m "feat(server): add owner-only pairing-url endpoint for client links"
```

---

## Phase C — Client: Host model, credential store, host-aware connection

### Task C1: `Host` type + host store (Zustand, persisted)

**Files:**
- Create: `apps/web/src/hosts/hostStore.ts`
- Test: `apps/web/src/hosts/hostStore.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type HostKind = "local" | "remote";
  export interface Host {
    readonly id: string;
    readonly label: string;
    readonly kind: HostKind;
    readonly baseUrl: string | null; // null only for the pinned local host
    readonly createdAt: number;
    lastConnectedAt: number | null;
  }
  export const LOCAL_HOST_ID = "local";
  export interface HostStoreState {
    hosts: Host[];
    activeHostId: string;
    addRemoteHost: (input: { label: string; baseUrl: string }) => Host;
    removeHost: (hostId: string) => void;
    renameHost: (hostId: string, label: string) => void;
    setActiveHostId: (hostId: string) => void;
    markConnected: (hostId: string, at: number) => void;
    getActiveHost: () => Host;
  }
  export const useHostStore; // Zustand hook
  ```
- The pinned local host (`id: LOCAL_HOST_ID`, `kind: "local"`, `baseUrl: null`) is always present and non-removable; it only appears on desktop (gated by `isElectron` at read sites, see C5).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hosts/hostStore.test.ts
import { beforeEach, describe, expect, it } from "vitest";

import { LOCAL_HOST_ID, useHostStore } from "./hostStore";

beforeEach(() => {
  localStorage.clear();
  useHostStore.persist.clearStorage();
  useHostStore.setState(useHostStore.getInitialState(), true);
});

describe("hostStore", () => {
  it("starts with the pinned local host active", () => {
    const state = useHostStore.getState();
    expect(state.hosts.some((h) => h.id === LOCAL_HOST_ID)).toBe(true);
    expect(state.activeHostId).toBe(LOCAL_HOST_ID);
  });

  it("adds a remote host and can activate it", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Mac Studio", baseUrl: "https://studio.ts.net:3773" });
    expect(host.kind).toBe("remote");
    useHostStore.getState().setActiveHostId(host.id);
    expect(useHostStore.getState().getActiveHost().label).toBe("Mac Studio");
  });

  it("refuses to remove the local host and falls back to local when removing the active host", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773" });
    useHostStore.getState().setActiveHostId(host.id);
    useHostStore.getState().removeHost(LOCAL_HOST_ID);
    expect(useHostStore.getState().hosts.some((h) => h.id === LOCAL_HOST_ID)).toBe(true);
    useHostStore.getState().removeHost(host.id);
    expect(useHostStore.getState().activeHostId).toBe(LOCAL_HOST_ID);
    expect(useHostStore.getState().hosts.some((h) => h.id === host.id)).toBe(false);
  });

  it("normalizes baseUrl to an origin (strips trailing path/slash)", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773/pair" });
    expect(host.baseUrl).toBe("https://studio.ts.net:3773");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/hosts/hostStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/src/hosts/hostStore.ts
// FILE: hostStore.ts
// Purpose: Persisted list of Synara hosts + the active host pointer.
// Layer: Web state
// Exports: Host, HostKind, LOCAL_HOST_ID, useHostStore

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type HostKind = "local" | "remote";

export interface Host {
  readonly id: string;
  readonly label: string;
  readonly kind: HostKind;
  readonly baseUrl: string | null;
  readonly createdAt: number;
  lastConnectedAt: number | null;
}

export const LOCAL_HOST_ID = "local";
const HOST_STORE_STORAGE_KEY = "synara:hosts:v1";

const localHost = (): Host => ({
  id: LOCAL_HOST_ID,
  label: "Local",
  kind: "local",
  baseUrl: null,
  createdAt: 0,
  lastConnectedAt: null,
});

function normalizeBaseUrl(raw: string): string {
  return new URL(raw).origin;
}

function generateHostId(): string {
  return `host_${crypto.randomUUID()}`;
}

export interface HostStoreState {
  hosts: Host[];
  activeHostId: string;
  addRemoteHost: (input: { label: string; baseUrl: string }) => Host;
  removeHost: (hostId: string) => void;
  renameHost: (hostId: string, label: string) => void;
  setActiveHostId: (hostId: string) => void;
  markConnected: (hostId: string, at: number) => void;
  getActiveHost: () => Host;
}

export const useHostStore = create<HostStoreState>()(
  persist(
    (set, get) => ({
      hosts: [localHost()],
      activeHostId: LOCAL_HOST_ID,
      addRemoteHost: ({ label, baseUrl }) => {
        const normalized = normalizeBaseUrl(baseUrl);
        const existing = get().hosts.find(
          (h) => h.kind === "remote" && h.baseUrl === normalized,
        );
        if (existing) {
          set((s) => ({
            hosts: s.hosts.map((h) =>
              h.id === existing.id ? { ...h, label: label.trim() || h.label } : h,
            ),
          }));
          return get().hosts.find((h) => h.id === existing.id)!;
        }
        const host: Host = {
          id: generateHostId(),
          label: label.trim() || normalized,
          kind: "remote",
          baseUrl: normalized,
          createdAt: Date.now(),
          lastConnectedAt: null,
        };
        set((s) => ({ hosts: [...s.hosts, host] }));
        return host;
      },
      removeHost: (hostId) => {
        if (hostId === LOCAL_HOST_ID) return;
        set((s) => {
          const hosts = s.hosts.filter((h) => h.id !== hostId);
          const activeHostId = s.activeHostId === hostId ? LOCAL_HOST_ID : s.activeHostId;
          return { hosts, activeHostId };
        });
      },
      renameHost: (hostId, label) =>
        set((s) => ({
          hosts: s.hosts.map((h) =>
            h.id === hostId ? { ...h, label: label.trim() || h.label } : h,
          ),
        })),
      setActiveHostId: (hostId) => {
        if (!get().hosts.some((h) => h.id === hostId)) return;
        set({ activeHostId: hostId });
      },
      markConnected: (hostId, at) =>
        set((s) => ({
          hosts: s.hosts.map((h) => (h.id === hostId ? { ...h, lastConnectedAt: at } : h)),
        })),
      getActiveHost: () => {
        const s = get();
        return s.hosts.find((h) => h.id === s.activeHostId) ?? localHost();
      },
    }),
    {
      name: HOST_STORE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ hosts: s.hosts, activeHostId: s.activeHostId }),
      merge: (persisted, current) => {
        const candidate = (persisted as Partial<HostStoreState> | undefined) ?? {};
        const remotes = (candidate.hosts ?? []).filter(
          (h): h is Host => !!h && h.kind === "remote" && typeof h.baseUrl === "string",
        );
        const hosts = [localHost(), ...remotes];
        const activeHostId =
          candidate.activeHostId && hosts.some((h) => h.id === candidate.activeHostId)
            ? candidate.activeHostId
            : LOCAL_HOST_ID;
        return { ...current, hosts, activeHostId };
      },
    },
  ),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/hosts/hostStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hosts/hostStore.ts apps/web/src/hosts/hostStore.test.ts
git commit -m "feat(web): add persisted host store with pinned local host"
```

### Task C2: Credential store abstraction (keychain or localStorage)

**Files:**
- Create: `apps/web/src/hosts/hostCredentialStore.ts`
- Test: `apps/web/src/hosts/hostCredentialStore.test.ts`

**Interfaces:**
- Consumes: `window.desktopBridge?.secureCredentialStore` (added in Phase F) when present; falls back to `localStorage`.
- Produces:
  ```typescript
  export interface HostCredentialStore {
    get(hostId: string): Promise<string | null>;
    set(hostId: string, credential: string): Promise<void>;
    delete(hostId: string): Promise<void>;
  }
  export function getHostCredentialStore(): HostCredentialStore;
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hosts/hostCredentialStore.test.ts
import { beforeEach, describe, expect, it } from "vitest";

import { getHostCredentialStore } from "./hostCredentialStore";

beforeEach(() => {
  localStorage.clear();
  // Ensure no desktop bridge in this environment so the localStorage path is exercised.
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

describe("hostCredentialStore (localStorage fallback)", () => {
  it("round-trips a credential", async () => {
    const store = getHostCredentialStore();
    await store.set("host_1", "SECRETTOKEN");
    expect(await store.get("host_1")).toBe("SECRETTOKEN");
  });

  it("returns null for an unknown host", async () => {
    expect(await getHostCredentialStore().get("nope")).toBeNull();
  });

  it("deletes a credential", async () => {
    const store = getHostCredentialStore();
    await store.set("host_1", "X");
    await store.delete("host_1");
    expect(await store.get("host_1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/hosts/hostCredentialStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/src/hosts/hostCredentialStore.ts
// FILE: hostCredentialStore.ts
// Purpose: Secure-ish storage for per-host bearer credentials. Uses the desktop
//          keychain bridge when present, else localStorage (tailnet-scoped token).
// Layer: Web state
// Exports: HostCredentialStore, getHostCredentialStore

const KEY_PREFIX = "synara:host-credential:";

export interface HostCredentialStore {
  get(hostId: string): Promise<string | null>;
  set(hostId: string, credential: string): Promise<void>;
  delete(hostId: string): Promise<void>;
}

function localStorageStore(): HostCredentialStore {
  const key = (hostId: string) => `${KEY_PREFIX}${hostId}`;
  return {
    get: async (hostId) => localStorage.getItem(key(hostId)),
    set: async (hostId, credential) => localStorage.setItem(key(hostId), credential),
    delete: async (hostId) => localStorage.removeItem(key(hostId)),
  };
}

export function getHostCredentialStore(): HostCredentialStore {
  const bridge = window.desktopBridge?.secureCredentialStore;
  if (bridge) {
    return {
      get: (hostId) => bridge.get(`${KEY_PREFIX}${hostId}`),
      set: (hostId, credential) => bridge.set(`${KEY_PREFIX}${hostId}`, credential),
      delete: (hostId) => bridge.delete(`${KEY_PREFIX}${hostId}`),
    };
  }
  return localStorageStore();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/hosts/hostCredentialStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hosts/hostCredentialStore.ts apps/web/src/hosts/hostCredentialStore.test.ts
git commit -m "feat(web): add per-host credential store abstraction"
```

### Task C3: `HostConnection` — host-aware auth fetch + ws-token URL

**Files:**
- Create: `apps/web/src/hosts/hostConnection.ts`
- Test: `apps/web/src/hosts/hostConnection.test.ts`

**Interfaces:**
- Consumes: `Host` (C1), `HostCredentialStore` (C2).
- Produces:
  ```typescript
  export interface HostConnection {
    readonly host: Host;
    // Absolute or relative path -> response JSON. Local: relative + same-origin cookie.
    // Remote: absolute baseUrl + Authorization: Bearer.
    requestAuthJson<T>(path: string, options?: { method?: "GET" | "POST"; body?: unknown }): Promise<T>;
    // Resolves the /ws socket URL, fetching+appending a fresh wsToken for remote.
    resolveSocketUrl(): Promise<string>;
  }
  export function makeHostConnection(host: Host, deps?: { credentials?: HostCredentialStore }): HostConnection;
  ```
- `resolveSocketUrl()` for **local** returns the existing behavior (`window.desktopBridge?.getWsUrl()` → `/ws`); for **remote** it fetches `POST {baseUrl}/api/auth/ws-token` (bearer) and returns `wss?://host/ws?wsToken=<token>`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hosts/hostConnection.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Host } from "./hostStore";
import { makeHostConnection } from "./hostConnection";
import type { HostCredentialStore } from "./hostCredentialStore";

const remoteHost: Host = {
  id: "host_1",
  label: "Studio",
  kind: "remote",
  baseUrl: "https://studio.ts.net:3773",
  createdAt: 0,
  lastConnectedAt: null,
};

const creds = (token: string | null): HostCredentialStore => ({
  get: async () => token,
  set: async () => {},
  delete: async () => {},
});

afterEach(() => vi.restoreAllMocks());

describe("makeHostConnection (remote)", () => {
  it("sends Authorization: Bearer with an absolute URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const conn = makeHostConnection(remoteHost, { credentials: creds("BEARER123") });
    await conn.requestAuthJson("/api/auth/session");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://studio.ts.net:3773/api/auth/session");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer BEARER123");
    expect(init?.credentials).toBe("omit");
  });

  it("resolves a wss /ws URL with a fresh wsToken", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "WS_TOKEN", expiresAt: "2030-01-01T00:00:00Z" }), {
        status: 200,
      }),
    );
    const conn = makeHostConnection(remoteHost, { credentials: creds("BEARER123") });
    const url = await conn.resolveSocketUrl();
    expect(url).toBe("wss://studio.ts.net:3773/ws?wsToken=WS_TOKEN");
  });

  it("throws a typed error when no credential is stored", async () => {
    const conn = makeHostConnection(remoteHost, { credentials: creds(null) });
    await expect(conn.requestAuthJson("/api/auth/session")).rejects.toThrow(/credential/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/hosts/hostConnection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
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
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/hosts/hostConnection.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hosts/hostConnection.ts apps/web/src/hosts/hostConnection.test.ts
git commit -m "feat(web): add host-aware connection (bearer + ws-token) abstraction"
```

### Task C4: Transport accepts an async socket-URL resolver (fresh token per session)

**Files:**
- Modify: `apps/web/src/wsTransport.ts` (constructor ~134; `createSession` ~263; `dispose` ~244; `reconnect` ~293; `openReconnectSession` ~329)
- Test: `apps/web/src/wsTransport.test.ts` (existing — add a case)

**Interfaces:**
- Produces: `new WsTransport(url?: string | (() => Promise<string>))`. Accepts BOTH the legacy string form (back-compat with existing tests/callers) and an async resolver. When omitted, behavior is identical to today (uses `makeSocketUrl(null)`). Each session (initial + every reconnect) calls the resolver so a fresh `wsToken` is fetched on reconnect.
- Consumes: nothing new at call sites that don't pass a resolver.

> **Back-compat note:** the original signature was `constructor(url?: string)`. Keep existing string callers working by normalizing a string argument into a resolver (`() => Promise.resolve(resolveRpcUrl(url))`). Do NOT break `apps/web/src/wsTransport.test.ts`'s existing construction calls — read them first and keep them green.

- [ ] **Step 1: Write the failing test** — add to `apps/web/src/wsTransport.test.ts`

```typescript
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
```

> The existing test file uses `effectRpcWebSocketMock` for connected behavior; this added case only asserts the resolver is invoked, so it does not need a live socket. Keep the mock setup the file already uses for its other tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/wsTransport.test.ts`
Expected: FAIL — `WsTransport` constructor ignores a function arg (TypeScript error or resolver never called).

- [ ] **Step 3: Refactor the transport**

Replace the constructor + `createSession` + the runtime/scope fields so the runtime is built **after** the URL resolves. Concretely:

Change the field declarations (around line 124-126) from synchronous `runtime`/`clientScope` to nullable, plus add the resolver and a per-session promise:

```typescript
  private readonly resolveUrl: () => Promise<string>;
  // (Remove the old `private readonly explicitUrl: string | null;` field.)
  private runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> | null = null;
  private clientScope: Scope.Closeable | null = null;
  private sessionReady: Promise<{
    runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
    clientScope: Scope.Closeable;
  }> | null = null;
  private clientPromise: Promise<RpcClientInstance>;
```

Constructor (normalizes the legacy string form into a resolver):

```typescript
  constructor(url?: string | (() => Promise<string>)) {
    this.resolveUrl =
      typeof url === "function"
        ? url
        : typeof url === "string"
          ? () => Promise.resolve(resolveRpcUrl(url))
          : () => Promise.resolve(makeSocketUrl(null));
    const session = this.createSession();
    this.clientPromise = session.clientPromise;
  }
```

`createSession` (build runtime after URL resolves; store handles on `this` once ready):

```typescript
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
      .then(({ runtime, clientScope }) =>
        runtime.runPromise(Scope.provide(clientScope)(makeRpcClient)),
      )
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
```

Everywhere the code previously used `this.runtime` / `this.clientScope` synchronously (in `startStream` via `this.runtime.runCallback`, in `dispose`, in `reconnect`, in `runGitActionStream`, in `request`), guard against null by awaiting readiness. The hot path is `startStream`, which runs after `getClient()` resolves — by then `this.runtime` is set, so add a non-null assertion helper:

```typescript
  private requireRuntime(): ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> {
    if (!this.runtime) throw new Error("Transport runtime not ready");
    return this.runtime;
  }
```

Replace `this.runtime.run*` calls in `startStream`/`runGitActionStream`/`request` with `this.requireRuntime().run*` (these all execute after `getClient()` so the runtime is ready).

`dispose` and `reconnect` must close the scope/runtime once ready instead of synchronously:

```typescript
  dispose() {
    this.disposed = true;
    this.setState("disposed");
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    void this.clientPromise.catch(() => undefined);
    void this.reconnectPromise?.catch(() => undefined);
    const ready = this.sessionReady;
    void ready
      ?.then(({ runtime, clientScope }) =>
        runtime.runPromise(Scope.close(clientScope, Exit.void)).finally(() => runtime.dispose()),
      )
      .catch(() => undefined);
  }
```

In `reconnect`, replace the synchronous `oldRuntime`/`oldClientScope` capture with the ready promise:

```typescript
  private reconnect(): Promise<RpcClientInstance> {
    if (this.reconnectPromise) return this.reconnectPromise;
    const oldReady = this.sessionReady;
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    this.stoppingStreams.clear();
    this.setState("connecting");
    void oldReady
      ?.then(({ runtime, clientScope }) =>
        runtime.runPromise(Scope.close(clientScope, Exit.void)).finally(() => runtime.dispose()),
      )
      .catch(() => undefined);
    this.reconnectPromise = this.openReconnectSession().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }
```

In `openReconnectSession`, after computing the backoff delay, just call `this.createSession()` (it now resolves a fresh URL — i.e. a fresh wsToken) and await its `clientPromise`:

```typescript
  private async openReconnectSession(): Promise<RpcClientInstance> {
    const delayMs = Math.min(500 * 2 ** this.reconnectFailures, 5_000);
    this.reconnectFailures += 1;
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    const session = this.createSession();
    this.clientPromise = session.clientPromise;
    const client = await session.clientPromise;
    this.reconnectFailures = 0;
    for (const channel of this.listeners.keys()) {
      this.startChannelStream(channel as WsPushChannel);
    }
    if (this.shellSubscribed) this.startShellStream(client);
    for (const [threadId, input] of this.threadSubscriptions) {
      this.startThreadStream(client, threadId, input);
    }
    return client;
  }
```

> Keep `makeSocketUrl`, `resolveRpcUrl`, `makeProtocolLayer` as-is. The only behavioral change is that the URL is now produced by `resolveUrl()` per session. Default construction (`new WsTransport()`) is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/wsTransport.test.ts`
Expected: PASS — all pre-existing tests plus the new resolver case.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/wsTransport.ts apps/web/src/wsTransport.test.ts
git commit -m "refactor(web): transport resolves socket URL asynchronously per session"
```

### Task C5: Host-aware native API + active-host wiring

**Files:**
- Modify: `apps/web/src/wsNativeApi.ts` (`requestAuthJson` ~104; `createWsNativeApi` ~315; `resetWsNativeApiForTest` ~910)
- Modify: `apps/web/src/nativeApi.ts` (full file)
- Create: `apps/web/src/hosts/activeHostConnection.ts`
- Test: `apps/web/src/wsNativeApi.test.ts` (existing — add a case)

**Interfaces:**
- Consumes: `makeHostConnection` (C3), `useHostStore` (C1), `isElectron`.
- Produces:
  - `apps/web/src/hosts/activeHostConnection.ts`: `getActiveHostConnection(): HostConnection` — builds a `HostConnection` for the current `useHostStore.getState().getActiveHost()` (forces Local when not electron).
  - `createWsNativeApi(connection?: HostConnection)` — when omitted, uses `getActiveHostConnection()`. The module `requestAuthJson` delegates to the connection. The transport is constructed as `new WsTransport(() => connection.resolveSocketUrl())`.

- [ ] **Step 1: Write `activeHostConnection.ts`**

```typescript
// apps/web/src/hosts/activeHostConnection.ts
// FILE: activeHostConnection.ts
// Purpose: Resolve the HostConnection for the currently active host.
// Layer: Web transport
// Exports: getActiveHostConnection

import { isElectron } from "../env";
import { LOCAL_HOST_ID, useHostStore, type Host } from "./hostStore";
import { makeHostConnection, type HostConnection } from "./hostConnection";

export function getActiveHostConnection(): HostConnection {
  const state = useHostStore.getState();
  let host: Host = state.getActiveHost();
  // The local host only exists on desktop; a browser must always be on a remote host.
  if (!isElectron && host.kind === "local") {
    const firstRemote = state.hosts.find((h) => h.kind === "remote");
    host = firstRemote ?? host;
  }
  void LOCAL_HOST_ID;
  return makeHostConnection(host);
}
```

- [ ] **Step 2: Write the failing test** — add to `apps/web/src/wsNativeApi.test.ts`

```typescript
it("routes auth requests through the active host connection", async () => {
  // Build a fake connection that records calls.
  const calls: string[] = [];
  const connection = {
    host: { id: "host_x", kind: "remote", baseUrl: "https://x", label: "X", createdAt: 0, lastConnectedAt: null },
    requestAuthJson: async <T>(path: string) => {
      calls.push(path);
      return { authenticated: true } as unknown as T;
    },
    resolveSocketUrl: async () => "wss://x/ws?wsToken=T",
  };
  const api = createWsNativeApi(connection as never);
  await api.server.getAuthSession();
  expect(calls).toContain("/api/auth/session");
  resetWsNativeApiForTest();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test apps/web/src/wsNativeApi.test.ts`
Expected: FAIL — `createWsNativeApi` takes no argument / `requestAuthJson` is module-level, not connection-routed.

- [ ] **Step 4: Implement**

In `apps/web/src/wsNativeApi.ts`:

1. Add import:
```typescript
import { getActiveHostConnection } from "./hosts/activeHostConnection";
import type { HostConnection } from "./hosts/hostConnection";
```

2. Change `createWsNativeApi` signature and the transport construction + the module-level `requestAuthJson` so it uses the connection. Since `requestAuthJson` is currently a free function used inside the `api.server.*` closures, move the active connection into a closure variable at the top of `createWsNativeApi`:

```typescript
export function createWsNativeApi(connection: HostConnection = getActiveHostConnection()): NativeApi {
  if (instance) {
    if (instance.transport.getState() !== "disposed") {
      return instance.api;
    }
    instance = null;
  }

  const transport = new WsTransport(() => connection.resolveSocketUrl());
  // ...existing subscribe(...) wiring unchanged...
```

3. Replace each `requestAuthJson<...>("/api/...", ...)` call inside the `server` object with `connection.requestAuthJson<...>("/api/...", ...)`. Delete the now-unused module-level `requestAuthJson` function (or keep it only if other call sites remain — grep first; if none, remove it).

4. `resetWsNativeApiForTest()` stays as-is (it disposes `instance.transport` and clears listeners).

- [ ] **Step 5: Update `nativeApi.ts`** so the browser path passes through the active host:

```typescript
// apps/web/src/nativeApi.ts
import type { NativeApi } from "@t3tools/contracts";
import { createWsNativeApi } from "./wsNativeApi";

let cachedDesktopApi: NativeApi | undefined;

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedDesktopApi && window.nativeApi === cachedDesktopApi) return cachedDesktopApi;
  if (window.nativeApi) {
    cachedDesktopApi = window.nativeApi;
    return cachedDesktopApi;
  }
  return createWsNativeApi();
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) throw new Error("Native API not found");
  return api;
}
```

> Note: `window.nativeApi` (Electron in-process API) still short-circuits and represents the **Local** host. Remote hosts always go through `createWsNativeApi()` with the active connection. The desktop app does not set `window.nativeApi` for remote hosts — it relies on the WS path. Confirm the desktop sets `window.nativeApi` only for the bundled backend (grep `preload.ts`/`main.ts` for `nativeApi`); if it always sets it, gate it so remote hosts bypass it (see Phase D switch logic).

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run test apps/web/src/wsNativeApi.test.ts`
Expected: PASS, including the new case and existing ones.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/wsNativeApi.ts apps/web/src/nativeApi.ts apps/web/src/hosts/activeHostConnection.ts apps/web/src/wsNativeApi.test.ts
git commit -m "feat(web): route native API auth + socket through the active host"
```

---

## Phase D — Client: rebuild-on-switch lifecycle

### Task D1: Store-reset registry

**Files:**
- Create: `apps/web/src/hosts/hostScopedStores.ts`
- Test: `apps/web/src/hosts/hostScopedStores.test.ts`

**Interfaces:**
- Produces:
  - `registerHostScopedReset(reset: () => void): void` — stores register their reset fn.
  - `resetAllHostScopedStores(): void` — invokes all registered resets.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hosts/hostScopedStores.test.ts
import { describe, expect, it } from "vitest";

import { registerHostScopedReset, resetAllHostScopedStores } from "./hostScopedStores";

describe("hostScopedStores", () => {
  it("invokes every registered reset", () => {
    let a = 0;
    let b = 0;
    registerHostScopedReset(() => (a += 1));
    registerHostScopedReset(() => (b += 1));
    resetAllHostScopedStores();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/hosts/hostScopedStores.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/src/hosts/hostScopedStores.ts
// FILE: hostScopedStores.ts
// Purpose: Registry of store resets to run when switching the active host.
// Layer: Web state
// Exports: registerHostScopedReset, resetAllHostScopedStores

const resets = new Set<() => void>();

export function registerHostScopedReset(reset: () => void): void {
  resets.add(reset);
}

export function resetAllHostScopedStores(): void {
  for (const reset of resets) {
    try {
      reset();
    } catch {
      // A failing reset must not block the host switch.
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/hosts/hostScopedStores.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the core stores' resets**

In `apps/web/src/store.ts`, after the store is created, register a reset that returns to `initialState` (preserving nothing host-specific):

```typescript
import { registerHostScopedReset } from "./hosts/hostScopedStores";
// after `export const useStore = create<...>(...)`:
registerHostScopedReset(() => useStore.setState(initialState, true));
```

Repeat for the other host-scoped stores (each near its `create(...)`):
- `apps/web/src/workspaceStore.ts` → `registerHostScopedReset(() => useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true))`
- `apps/web/src/terminalStateStore.ts`, `apps/web/src/projectRunStore.ts`, `apps/web/src/threadSelectionStore.ts`, `apps/web/src/splitViewStore.ts`, `apps/web/src/temporaryThreadStore.ts` → same pattern with their own hooks.

> Do NOT register device-global stores that should survive a switch: `hostStore`, `editorPreferences`, `appSettings`, `pinnedProjectsStore`/`pinnedThreadsStore` (these are arguably host-specific, but pins reference cwds/threadIds that only exist on one host — register them for reset too to avoid cross-host bleed). When unsure, prefer resetting: a stale cross-host entry is worse than a lost pin. Document each decision in a one-line comment at the registration site.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/hosts/hostScopedStores.ts apps/web/src/hosts/hostScopedStores.test.ts apps/web/src/store.ts apps/web/src/workspaceStore.ts apps/web/src/terminalStateStore.ts apps/web/src/projectRunStore.ts apps/web/src/threadSelectionStore.ts apps/web/src/splitViewStore.ts apps/web/src/temporaryThreadStore.ts
git commit -m "feat(web): add host-scoped store reset registry"
```

### Task D2: `switchActiveHost` orchestration

**Files:**
- Create: `apps/web/src/hosts/switchActiveHost.ts`
- Test: `apps/web/src/hosts/switchActiveHost.test.ts`

**Interfaces:**
- Consumes: `useHostStore` (C1), `resetWsNativeApiForTest`-style dispose (reuse the singleton dispose path), `resetAllHostScopedStores` (D1).
- Produces: `switchActiveHost(hostId: string): void` — sets active host, disposes the current native API/transport, resets host-scoped stores, then reloads the app shell so the next `readNativeApi()` builds the new connection.

> **Design choice:** because the native-API singleton, router state, and all stores are deeply intertwined, the simplest correct rebuild is a **full page reload** after persisting the new `activeHostId`. The host store is persisted, so on reload the new host is active. This is Approach 1's "brief reconnect moment" made concrete and bulletproof. (A no-reload teardown is possible later but is not worth the risk now.)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hosts/switchActiveHost.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useHostStore } from "./hostStore";
import { switchActiveHost } from "./switchActiveHost";

beforeEach(() => {
  localStorage.clear();
  useHostStore.setState(useHostStore.getInitialState(), true);
});

describe("switchActiveHost", () => {
  it("persists the new active host id and reloads", () => {
    const host = useHostStore
      .getState()
      .addRemoteHost({ label: "Studio", baseUrl: "https://studio.ts.net:3773" });
    const reload = vi.fn();
    switchActiveHost(host.id, { reload });
    expect(useHostStore.getState().activeHostId).toBe(host.id);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does nothing when switching to the already-active host", () => {
    const reload = vi.fn();
    switchActiveHost(useHostStore.getState().activeHostId, { reload });
    expect(reload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/hosts/switchActiveHost.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/src/hosts/switchActiveHost.ts
// FILE: switchActiveHost.ts
// Purpose: Rebuild-on-switch — persist the new active host and reload the shell.
// Layer: Web state
// Exports: switchActiveHost

import { resetAllHostScopedStores } from "./hostScopedStores";
import { useHostStore } from "./hostStore";

export function switchActiveHost(
  hostId: string,
  deps?: { reload?: () => void },
): void {
  const state = useHostStore.getState();
  if (state.activeHostId === hostId) return;
  if (!state.hosts.some((h) => h.id === hostId)) return;
  state.setActiveHostId(hostId);
  resetAllHostScopedStores();
  const reload = deps?.reload ?? (() => window.location.reload());
  reload();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/hosts/switchActiveHost.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hosts/switchActiveHost.ts apps/web/src/hosts/switchActiveHost.test.ts
git commit -m "feat(web): add rebuild-on-switch host switching"
```

---

## Phase E — Client: pairing (redeem + add-host)

### Task E1: Pairing link parse + redeem logic

**Files:**
- Create: `apps/web/src/hosts/pairing.ts`
- Test: `apps/web/src/hosts/pairing.test.ts`

**Interfaces:**
- Consumes: `getHostCredentialStore` (C2), `useHostStore` (C1).
- Produces:
  - `parsePairingLink(link: string): { baseUrl: string; credential: string } | null` — accepts a full `https://host/pair#token=…` link (also tolerates `?token=` and a bare token only if a `baseUrl` is supplied separately → return null for bare).
  - `redeemPairingLink(link: string, deps?: {...}): Promise<Host>` — parses, POSTs `{credential}` to `${baseUrl}/api/auth/bootstrap/bearer`, stores the returned `sessionToken` under the new host id, adds the host to the store, returns it.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hosts/pairing.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHostStore } from "./hostStore";
import { parsePairingLink, redeemPairingLink } from "./pairing";

beforeEach(() => {
  localStorage.clear();
  useHostStore.setState(useHostStore.getInitialState(), true);
});
afterEach(() => vi.restoreAllMocks());

describe("parsePairingLink", () => {
  it("extracts origin + token from a /pair#token= link", () => {
    expect(parsePairingLink("https://studio.ts.net:3773/pair#token=ABCD1234WXYZ")).toEqual({
      baseUrl: "https://studio.ts.net:3773",
      credential: "ABCD1234WXYZ",
    });
  });
  it("returns null for a link without a token", () => {
    expect(parsePairingLink("https://studio.ts.net:3773/pair")).toBeNull();
  });
  it("returns null for non-URL input", () => {
    expect(parsePairingLink("not a link")).toBeNull();
  });
});

describe("redeemPairingLink", () => {
  it("redeems, stores the bearer, and adds the host", async () => {
    const credStore = { stored: new Map<string, string>() };
    const credentials = {
      get: async (id: string) => credStore.stored.get(id) ?? null,
      set: async (id: string, v: string) => void credStore.stored.set(id, v),
      delete: async (id: string) => void credStore.stored.delete(id),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          role: "client",
          sessionMethod: "bearer-session-token",
          expiresAt: "2030-01-01T00:00:00Z",
          sessionToken: "BEARER_TOKEN",
        }),
        { status: 200 },
      ),
    );
    const host = await redeemPairingLink("https://studio.ts.net:3773/pair#token=ABCD1234WXYZ", {
      credentials,
      label: "Mac Studio",
    });
    expect(host.kind).toBe("remote");
    expect(host.baseUrl).toBe("https://studio.ts.net:3773");
    expect(credStore.stored.get(host.id)).toBe("BEARER_TOKEN");
    expect(useHostStore.getState().hosts.some((h) => h.id === host.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/hosts/pairing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/src/hosts/pairing.ts
// FILE: pairing.ts
// Purpose: Parse pairing links and redeem them into a stored remote host.
// Layer: Web state
// Exports: parsePairingLink, redeemPairingLink

import { getHostCredentialStore, type HostCredentialStore } from "./hostCredentialStore";
import { useHostStore, type Host } from "./hostStore";

export function parsePairingLink(link: string): { baseUrl: string; credential: string } | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const fromHash = new URLSearchParams(url.hash.replace(/^#/, "")).get("token");
  const fromQuery = url.searchParams.get("token");
  const credential = (fromHash ?? fromQuery ?? "").trim();
  if (!credential) return null;
  return { baseUrl: url.origin, credential };
}

export async function redeemPairingLink(
  link: string,
  deps?: { credentials?: HostCredentialStore; label?: string },
): Promise<Host> {
  const parsed = parsePairingLink(link);
  if (!parsed) throw new Error("That doesn't look like a valid pairing link.");
  const credentials = deps?.credentials ?? getHostCredentialStore();

  const response = await fetch(`${parsed.baseUrl}/api/auth/bootstrap/bearer`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: parsed.credential }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { sessionToken?: string; error?: string }
    | null;
  if (!response.ok || !payload?.sessionToken) {
    throw new Error(payload?.error ?? "Pairing failed. The link may have expired.");
  }

  const host = useHostStore
    .getState()
    .addRemoteHost({ label: deps?.label ?? "", baseUrl: parsed.baseUrl });
  await credentials.set(host.id, payload.sessionToken);
  return host;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/hosts/pairing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hosts/pairing.ts apps/web/src/hosts/pairing.test.ts
git commit -m "feat(web): add pairing link parse + redeem"
```

### Task E2: Public `/pair` route (phone same-origin redeem)

**Files:**
- Create: `apps/web/src/routes/pair.tsx`
- Modify: `apps/web/src/routeTree.gen.ts` (regenerated by codegen — do not hand-edit)
- Test: `apps/web/src/routes/pair.logic.test.ts` (pure logic extracted)
- Create: `apps/web/src/routes/pairRedeem.ts` (testable redeem-on-mount logic)

**Interfaces:**
- The `/pair` route is a **root-level public route** (sibling of `_chat`), so it renders without the auth/bootstrap gate.
- Produces: `pairRedeemFromLocation(href: string, deps): Promise<{ ok: true; hostId: string } | { ok: false; message: string }>`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/routes/pairRedeem.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHostStore } from "../hosts/hostStore";
import { pairRedeemFromLocation } from "./pairRedeem";

beforeEach(() => {
  localStorage.clear();
  useHostStore.setState(useHostStore.getInitialState(), true);
});
afterEach(() => vi.restoreAllMocks());

describe("pairRedeemFromLocation", () => {
  it("redeems the token from the current location hash and activates the host", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessionToken: "T", role: "client" }), { status: 200 }),
    );
    const result = await pairRedeemFromLocation(
      "https://studio.ts.net:3773/pair#token=ABCD1234WXYZ",
      {
        credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(useHostStore.getState().activeHostId).toBe(result.hostId);
    }
  });

  it("returns an error message for an invalid link", async () => {
    const result = await pairRedeemFromLocation("https://x/pair", {
      credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/routes/pairRedeem.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the redeem logic**

```typescript
// apps/web/src/routes/pairRedeem.ts
// FILE: pairRedeem.ts
// Purpose: Redeem a pairing link from the current URL and activate the host.
// Layer: Web route logic
// Exports: pairRedeemFromLocation

import type { HostCredentialStore } from "../hosts/hostCredentialStore";
import { useHostStore } from "../hosts/hostStore";
import { redeemPairingLink } from "../hosts/pairing";

export async function pairRedeemFromLocation(
  href: string,
  deps?: { credentials?: HostCredentialStore },
): Promise<{ ok: true; hostId: string } | { ok: false; message: string }> {
  try {
    const host = await redeemPairingLink(href, { credentials: deps?.credentials });
    useHostStore.getState().setActiveHostId(host.id);
    return { ok: true, hostId: host.id };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Pairing failed." };
  }
}
```

- [ ] **Step 4: Write the route component**

```tsx
// apps/web/src/routes/pair.tsx
// FILE: pair.tsx
// Purpose: Public route that redeems a pairing link, then enters the app.
// Layer: Route
// Exports: Route

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { pairRedeemFromLocation } from "./pairRedeem";

function PairView() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"pairing" | "error">("pairing");
  const [message, setMessage] = useState("Pairing this device…");

  useEffect(() => {
    let cancelled = false;
    void pairRedeemFromLocation(window.location.href).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        // Reload at the app root so the active host connection is built fresh.
        window.location.replace("/");
      } else {
        setStatus("error");
        setMessage(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="flex h-dvh items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <p className="text-sm text-muted-foreground">{message}</p>
        {status === "error" ? (
          <a className="mt-4 inline-block text-sm underline" href="/">
            Go back
          </a>
        ) : null}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/pair")({
  component: PairView,
});
```

> **Public-route placement:** the filename `pair.tsx` (no `_chat.` prefix) creates a root-level `/pair` route that does NOT inherit the `_chat` auth gate. After creating the file, run the codegen step so `routeTree.gen.ts` includes it.

- [ ] **Step 5: Regenerate the route tree + run tests**

Run: `bun run --cwd apps/web build` (or the project's codegen script — the TanStack Router Vite plugin regenerates `routeTree.gen.ts` on dev/build). Confirm `routeTree.gen.ts` now references `/pair`.
Run: `bun run test apps/web/src/routes/pairRedeem.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/pair.tsx apps/web/src/routes/pairRedeem.ts apps/web/src/routes/pairRedeem.test.ts apps/web/src/routeTree.gen.ts
git commit -m "feat(web): add public /pair route to redeem pairing links"
```

### Task E3: Add-host dialog (paste link, all clients)

**Files:**
- Create: `apps/web/src/components/hosts/AddHostDialog.tsx`
- Test: `apps/web/src/components/hosts/addHostDialog.logic.test.ts`
- Create: `apps/web/src/components/hosts/addHostDialogLogic.ts`

**Interfaces:**
- Consumes: `redeemPairingLink` (E1), `parsePairingLink` (E1).
- Produces: `validateAddHostInput(link: string): { valid: boolean; reason?: string }` + the dialog component (paste field → redeem → close).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/components/hosts/addHostDialog.logic.test.ts
import { describe, expect, it } from "vitest";

import { validateAddHostInput } from "./addHostDialogLogic";

describe("validateAddHostInput", () => {
  it("accepts a valid pairing link", () => {
    expect(validateAddHostInput("https://studio.ts.net:3773/pair#token=ABCD1234WXYZ").valid).toBe(
      true,
    );
  });
  it("rejects a link with no token", () => {
    const r = validateAddHostInput("https://studio.ts.net:3773/pair");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/token|pairing/i);
  });
  it("rejects empty input", () => {
    expect(validateAddHostInput("   ").valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/components/hosts/addHostDialog.logic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the logic**

```typescript
// apps/web/src/components/hosts/addHostDialogLogic.ts
// FILE: addHostDialogLogic.ts
// Purpose: Validation for the Add-host paste-link form.
// Layer: Web UI logic
// Exports: validateAddHostInput

import { parsePairingLink } from "../../hosts/pairing";

export function validateAddHostInput(link: string): { valid: boolean; reason?: string } {
  if (!link.trim()) return { valid: false, reason: "Paste a pairing link." };
  if (!parsePairingLink(link)) {
    return { valid: false, reason: "That link is missing a pairing token." };
  }
  return { valid: true };
}
```

- [ ] **Step 4: Write the dialog component**

```tsx
// apps/web/src/components/hosts/AddHostDialog.tsx
// FILE: AddHostDialog.tsx
// Purpose: Paste-a-pairing-link dialog to add a remote host (desktop + mobile).
// Layer: Web component
// Exports: AddHostDialog

import { useState } from "react";

import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { redeemPairingLink } from "../../hosts/pairing";
import { switchActiveHost } from "../../hosts/switchActiveHost";
import { validateAddHostInput } from "./addHostDialogLogic";

export function AddHostDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [link, setLink] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const validation = validateAddHostInput(link);
    if (!validation.valid) {
      setError(validation.reason ?? "Invalid link.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const host = await redeemPairingLink(link, { label });
      onOpenChange(false);
      switchActiveHost(host.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogTitle>Add a host</DialogTitle>
        <label className="mt-3 block text-sm">
          Pairing link
          <input
            className="mt-1 w-full rounded border bg-transparent px-2 py-1.5 text-sm"
            placeholder="https://…/pair#token=…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            autoFocus
          />
        </label>
        <label className="mt-3 block text-sm">
          Name (optional)
          <input
            className="mt-1 w-full rounded border bg-transparent px-2 py-1.5 text-sm"
            placeholder="Mac Studio"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        {error ? <p className="mt-2 text-sm text-red-500">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Pairing…" : "Add host"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
```

> Verify the exact exports of `apps/web/src/components/ui/dialog.tsx` and `button.tsx` (the探索 confirmed both exist). If the dialog API differs (e.g. `DialogContent` instead of `DialogPopup`), use the file's actual exports — copy a usage from an existing dialog in the app.

- [ ] **Step 5: Run test + commit**

Run: `bun run test apps/web/src/components/hosts/addHostDialog.logic.test.ts`
Expected: PASS (3 tests).

```bash
git add apps/web/src/components/hosts/AddHostDialog.tsx apps/web/src/components/hosts/addHostDialogLogic.ts apps/web/src/components/hosts/addHostDialog.logic.test.ts
git commit -m "feat(web): add paste-link Add-host dialog"
```

---

## Phase F — Desktop: secure credential store (Electron safeStorage)

### Task F1: `safeStorage`-backed credential logic

**Files:**
- Create: `apps/desktop/src/secureCredentialStore.ts`
- Test: `apps/desktop/src/secureCredentialStore.test.ts`

**Interfaces:**
- Produces: `makeSecureCredentialStore(deps: { encrypt; decrypt; isEncryptionAvailable; readFile; writeFile; filePath })` returning `{ get(key); set(key, value); delete(key) }`. Pure-ish, dependency-injected so it's testable without Electron.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/secureCredentialStore.test.ts
import { describe, expect, it } from "vitest";

import { makeSecureCredentialStore } from "./secureCredentialStore";

function inMemoryDeps() {
  let file = "";
  return {
    isEncryptionAvailable: () => true,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`),
    decrypt: (buf: Buffer) => buf.toString().replace(/^enc:/, ""),
    readFile: async () => file,
    writeFile: async (contents: string) => void (file = contents),
    filePath: "/tmp/creds.json",
  };
}

describe("makeSecureCredentialStore", () => {
  it("encrypts values on set and decrypts on get", async () => {
    const store = makeSecureCredentialStore(inMemoryDeps());
    await store.set("synara:host-credential:host_1", "TOKEN");
    expect(await store.get("synara:host-credential:host_1")).toBe("TOKEN");
  });

  it("returns null for an unknown key", async () => {
    const store = makeSecureCredentialStore(inMemoryDeps());
    expect(await store.get("missing")).toBeNull();
  });

  it("deletes a key", async () => {
    const store = makeSecureCredentialStore(inMemoryDeps());
    await store.set("k", "v");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/desktop/src/secureCredentialStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/secureCredentialStore.ts
// FILE: secureCredentialStore.ts
// Purpose: Encrypted on-disk credential map (Electron safeStorage), DI for tests.
// Layer: Desktop main
// Exports: makeSecureCredentialStore, SecureCredentialStoreDeps

export interface SecureCredentialStoreDeps {
  isEncryptionAvailable: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (cipher: Buffer) => string;
  readFile: () => Promise<string>;
  writeFile: (contents: string) => Promise<void>;
  filePath: string;
}

interface StoreShape {
  [key: string]: string; // base64 ciphertext (or plaintext when encryption unavailable)
}

export function makeSecureCredentialStore(deps: SecureCredentialStoreDeps) {
  const encryptionAvailable = deps.isEncryptionAvailable();

  async function load(): Promise<StoreShape> {
    try {
      const raw = await deps.readFile();
      return raw ? (JSON.parse(raw) as StoreShape) : {};
    } catch {
      return {};
    }
  }

  function encode(value: string): string {
    return encryptionAvailable ? deps.encrypt(value).toString("base64") : value;
  }
  function decode(stored: string): string {
    return encryptionAvailable ? deps.decrypt(Buffer.from(stored, "base64")) : stored;
  }

  return {
    async get(key: string): Promise<string | null> {
      const store = await load();
      const stored = store[key];
      if (stored === undefined) return null;
      try {
        return decode(stored);
      } catch {
        return null;
      }
    },
    async set(key: string, value: string): Promise<void> {
      const store = await load();
      store[key] = encode(value);
      await deps.writeFile(JSON.stringify(store));
    },
    async delete(key: string): Promise<void> {
      const store = await load();
      delete store[key];
      await deps.writeFile(JSON.stringify(store));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/desktop/src/secureCredentialStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/secureCredentialStore.ts apps/desktop/src/secureCredentialStore.test.ts
git commit -m "feat(desktop): add safeStorage-backed credential store logic"
```

### Task F2: Wire IPC channels + preload + DesktopBridge type

**Files:**
- Modify: `packages/contracts/src/ipc.ts` (DesktopBridge interface ~328–396)
- Modify: `apps/desktop/src/main.ts` (add channels + `ipcMain.handle`; near the other handlers ~2208–2244)
- Modify: `apps/desktop/src/preload.ts` (expose in `desktopBridge` ~43–172)

**Interfaces:**
- Produces: `window.desktopBridge.secureCredentialStore = { get(key): Promise<string|null>; set(key, value): Promise<void>; delete(key): Promise<void> }`.

- [ ] **Step 1: Add the type** — in `packages/contracts/src/ipc.ts`, inside `interface DesktopBridge`:

```typescript
  secureCredentialStore?: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
```

- [ ] **Step 2: Add handlers in `main.ts`** — near the existing handlers:

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { makeSecureCredentialStore } from "./secureCredentialStore";

const SECURE_CRED_GET = "desktop:secure-credential-get";
const SECURE_CRED_SET = "desktop:secure-credential-set";
const SECURE_CRED_DELETE = "desktop:secure-credential-delete";

const credentialStore = makeSecureCredentialStore({
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher),
  readFile: async () => {
    try {
      return await fs.readFile(path.join(app.getPath("userData"), "host-credentials.json"), "utf8");
    } catch {
      return "";
    }
  },
  writeFile: async (contents) =>
    fs.writeFile(path.join(app.getPath("userData"), "host-credentials.json"), contents, {
      mode: 0o600,
    }),
  filePath: path.join(app.getPath("userData"), "host-credentials.json"),
});

ipcMain.removeHandler(SECURE_CRED_GET);
ipcMain.handle(SECURE_CRED_GET, (_e, key: unknown) =>
  typeof key === "string" ? credentialStore.get(key) : null,
);
ipcMain.removeHandler(SECURE_CRED_SET);
ipcMain.handle(SECURE_CRED_SET, (_e, key: unknown, value: unknown) => {
  if (typeof key !== "string" || typeof value !== "string") throw new Error("Invalid credential");
  return credentialStore.set(key, value);
});
ipcMain.removeHandler(SECURE_CRED_DELETE);
ipcMain.handle(SECURE_CRED_DELETE, (_e, key: unknown) => {
  if (typeof key !== "string") throw new Error("Invalid key");
  return credentialStore.delete(key);
});
```

> Place the channel constants and handler registration alongside the existing `ipcMain.handle(...)` blocks; reuse existing imports if `app`/`safeStorage` are already imported (grep first to avoid duplicate imports).

- [ ] **Step 3: Expose in `preload.ts`** — inside the `contextBridge.exposeInMainWorld("desktopBridge", { ... })`:

```typescript
  secureCredentialStore: {
    get: (key: string) => ipcRenderer.invoke("desktop:secure-credential-get", key),
    set: (key: string, value: string) =>
      ipcRenderer.invoke("desktop:secure-credential-set", key, value),
    delete: (key: string) => ipcRenderer.invoke("desktop:secure-credential-delete", key),
  },
```

- [ ] **Step 4: Typecheck the contracts + desktop**

Run: `bun run typecheck`
Expected: PASS (DesktopBridge consumers see the new optional member; `hostCredentialStore.ts` from Task C2 picks it up).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/ipc.ts apps/desktop/src/main.ts apps/desktop/src/preload.ts
git commit -m "feat(desktop): expose secure credential store over IPC"
```

---

## Phase G — Client UI: host switcher, status, devices

### Task G1: Connection-status hook

**Files:**
- Create: `apps/web/src/hosts/useHostConnectionStatus.ts`
- Test: `apps/web/src/hosts/hostConnectionStatus.logic.test.ts`
- Create: `apps/web/src/hosts/hostConnectionStatus.ts` (pure mapping)

**Interfaces:**
- Consumes: `WsTransportState` (from `wsTransportEvents`), the existing `onWsTransportState` emitter in `wsNativeApi.ts`.
- Produces: `mapTransportStateToHostStatus(state: WsTransportState): "connected" | "connecting" | "unreachable"`, and a `useHostConnectionStatus()` hook returning the current status.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/hosts/hostConnectionStatus.logic.test.ts
import { describe, expect, it } from "vitest";

import { mapTransportStateToHostStatus } from "./hostConnectionStatus";

describe("mapTransportStateToHostStatus", () => {
  it("maps open -> connected", () => {
    expect(mapTransportStateToHostStatus("open")).toBe("connected");
  });
  it("maps connecting -> connecting", () => {
    expect(mapTransportStateToHostStatus("connecting")).toBe("connecting");
  });
  it("maps closed/disposed -> unreachable", () => {
    expect(mapTransportStateToHostStatus("closed")).toBe("unreachable");
    expect(mapTransportStateToHostStatus("disposed")).toBe("unreachable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/hosts/hostConnectionStatus.logic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the mapping + hook**

```typescript
// apps/web/src/hosts/hostConnectionStatus.ts
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
```

```typescript
// apps/web/src/hosts/useHostConnectionStatus.ts
// FILE: useHostConnectionStatus.ts
// Purpose: React hook exposing the active host's connection status.
// Layer: Web hook
// Exports: useHostConnectionStatus

import { useSyncExternalStore } from "react";

import { onWsTransportState, getWsTransportState } from "../wsNativeApi";
import { mapTransportStateToHostStatus, type HostConnectionStatus } from "./hostConnectionStatus";

export function useHostConnectionStatus(): HostConnectionStatus {
  const state = useSyncExternalStore(
    (cb) => onWsTransportState(cb),
    () => getWsTransportState(),
    () => "connecting" as const,
  );
  return mapTransportStateToHostStatus(state);
}
```

> Confirm `wsNativeApi.ts` exports `onWsTransportState` + a current-state getter. The探索 found `emitWsTransportState`; if the public subscribe/getter names differ, use the existing exported emitter API (grep `wsTransportEvents.ts` and `wsNativeApi.ts` for the transport-state subscription used elsewhere, e.g. a connection indicator).

- [ ] **Step 4: Run test + commit**

Run: `bun run test apps/web/src/hosts/hostConnectionStatus.logic.test.ts`
Expected: PASS (3 tests).

```bash
git add apps/web/src/hosts/hostConnectionStatus.ts apps/web/src/hosts/useHostConnectionStatus.ts apps/web/src/hosts/hostConnectionStatus.logic.test.ts
git commit -m "feat(web): add host connection status hook"
```

### Task G2: Host switcher in the sidebar header

**Files:**
- Create: `apps/web/src/components/hosts/HostSwitcher.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx` (header region ~6166–6180)

**Interfaces:**
- Consumes: `useHostStore` (C1), `switchActiveHost` (D2), `useHostConnectionStatus` (G1), `AddHostDialog` (E3), Base UI `Menu`.
- Produces: `HostSwitcher` component rendered in the sidebar header. On non-electron, it still renders (showing remote hosts only). Selecting a host calls `switchActiveHost`; "Add host…" opens `AddHostDialog`; "Manage devices…" navigates to `/settings` devices section.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/hosts/HostSwitcher.tsx
// FILE: HostSwitcher.tsx
// Purpose: Active-host dropdown for the sidebar header.
// Layer: Web component
// Exports: HostSwitcher

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { LOCAL_HOST_ID, useHostStore } from "../../hosts/hostStore";
import { switchActiveHost } from "../../hosts/switchActiveHost";
import { useHostConnectionStatus } from "../../hosts/useHostConnectionStatus";
import { isElectron } from "../../env";
import { AddHostDialog } from "./AddHostDialog";

const statusDot: Record<string, string> = {
  connected: "bg-green-500",
  connecting: "bg-amber-500",
  unreachable: "bg-red-500",
};

export function HostSwitcher() {
  const navigate = useNavigate();
  const hosts = useHostStore((s) => s.hosts);
  const activeHostId = useHostStore((s) => s.activeHostId);
  const status = useHostConnectionStatus();
  const [addOpen, setAddOpen] = useState(false);

  const visibleHosts = isElectron ? hosts : hosts.filter((h) => h.id !== LOCAL_HOST_ID);
  const active = hosts.find((h) => h.id === activeHostId);

  return (
    <>
      <Menu>
        <MenuTrigger className="flex items-center gap-2 rounded px-2 py-1 text-sm font-medium hover:bg-accent">
          <span className={`size-2 rounded-full ${statusDot[status] ?? "bg-zinc-400"}`} />
          <span className="truncate">{active?.label ?? "Local"}</span>
        </MenuTrigger>
        <MenuPopup>
          {visibleHosts.map((host) => (
            <MenuItem key={host.id} onClick={() => switchActiveHost(host.id)}>
              {host.label}
              {host.id === activeHostId ? " ✓" : ""}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => setAddOpen(true)}>Add host…</MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/settings", search: { section: "devices" } as never })}>
            Manage devices…
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AddHostDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}
```

> Confirm the `Menu` API (`Menu`/`MenuTrigger`/`MenuPopup`/`MenuItem`/`MenuSeparator`) and props from `apps/web/src/components/ui/menu.tsx`; copy a usage from an existing menu in the app. Confirm the settings route's search-param contract for selecting a section (the探索 found settings sections keyed by id; match its actual navigation contract — it may use a path param or a store, not search).

- [ ] **Step 2: Render it in the sidebar header**

In `apps/web/src/components/Sidebar.tsx`, import and place `<HostSwitcher />` in the non-electron header next to `{wordmark}` and in the electron header next to `{titlebarControls}` (so it shows in both). Add:

```tsx
import { HostSwitcher } from "./hosts/HostSwitcher";
```

and inside each `SidebarHeader` add `<HostSwitcher />` after the existing content.

- [ ] **Step 3: Verify build (no unit test for layout)**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/hosts/HostSwitcher.tsx apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): add host switcher to sidebar header"
```

### Task G3: Devices settings panel (generate link + QR + paired clients)

**Files:**
- Modify: `apps/web/src/settingsNavigation.ts` (add `devices` section + nav item)
- Modify: `apps/web/src/routes/_chat.settings.tsx` (render the panel for `devices`)
- Create: `apps/web/src/components/hosts/DevicesSettingsPanel.tsx`
- Add dependency: `qrcode` to `apps/web/package.json`.

**Interfaces:**
- Consumes: `ensureNativeApi().server.listAuthClients()`, `.revokeAuthClient()`, and the new `pairing-url` endpoint via a new `server.createAuthPairingUrl()` native method (add it mirroring `createAuthPairingToken`). `qrcode` (`QRCode.toDataURL`).
- Produces: a Devices panel that (a) generates a client pairing link + QR for the active host, (b) lists paired clients with revoke.

- [ ] **Step 1: Add the dependency**

```bash
bun add --cwd apps/web qrcode
bun add --cwd apps/web -d @types/qrcode
```

- [ ] **Step 2: Add the native API method** — in `apps/web/src/wsNativeApi.ts` `server` object, next to `createAuthPairingToken`:

```typescript
createAuthPairingUrl: (input?: { label?: string }) =>
  connection.requestAuthJson<{ url: string }>("/api/auth/pairing-url", {
    method: "POST",
    ...(input ? { body: input } : {}),
  }),
```

Add `createAuthPairingUrl` to the `NativeApi["server"]` type in `packages/contracts` (find where `createAuthPairingToken` is declared and add the sibling signature: `createAuthPairingUrl: (input?: { label?: string }) => Promise<{ url: string }>`).

- [ ] **Step 3: Add the settings nav item** — in `apps/web/src/settingsNavigation.ts`, add `"devices"` to `SETTINGS_SECTION_IDS` and a `SETTINGS_NAV_ITEMS` entry:

```typescript
{
  id: "devices",
  group: "app",
  label: "Devices",
  description: "Generate pairing links and manage paired devices for this host.",
  icon: "monitor", // use an existing icon id from the app's icon set
  eyebrow: "Multi-host",
},
```

> Use an icon id that exists in the app's icon registry (grep the icon component for valid ids; reuse one already used by another settings item if unsure).

- [ ] **Step 4: Write the panel**

```tsx
// apps/web/src/components/hosts/DevicesSettingsPanel.tsx
// FILE: DevicesSettingsPanel.tsx
// Purpose: Generate pairing links/QR and manage paired devices for the active host.
// Layer: Web component
// Exports: DevicesSettingsPanel

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { AuthClientSession } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { ensureNativeApi } from "../../nativeApi";

export function DevicesSettingsPanel() {
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [clients, setClients] = useState<readonly AuthClientSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshClients = async () => {
    try {
      setClients(await ensureNativeApi().server.listAuthClients());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load devices.");
    }
  };

  useEffect(() => {
    void refreshClients();
  }, []);

  const generate = async () => {
    setError(null);
    try {
      const { url } = await ensureNativeApi().server.createAuthPairingUrl();
      setLink(url);
      setQr(await QRCode.toDataURL(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create a pairing link.");
    }
  };

  const revoke = async (sessionId: AuthClientSession["sessionId"]) => {
    await ensureNativeApi().server.revokeAuthClient({ sessionId });
    await refreshClients();
  };

  return (
    <div className="space-y-6">
      <section>
        <Button onClick={generate}>Generate pairing link</Button>
        {error ? <p className="mt-2 text-sm text-red-500">{error}</p> : null}
        {link ? (
          <div className="mt-3 space-y-2">
            {qr ? <img alt="Pairing QR code" src={qr} className="size-44" /> : null}
            <input readOnly className="w-full rounded border bg-transparent px-2 py-1.5 text-xs" value={link} />
            <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(link)}>
              Copy link
            </Button>
          </div>
        ) : null}
      </section>
      <section>
        <h3 className="text-sm font-medium">Paired devices</h3>
        <ul className="mt-2 space-y-1">
          {clients.map((c) => (
            <li key={c.sessionId} className="flex items-center justify-between text-sm">
              <span>
                {c.client.label ?? c.subject} {c.current ? "(this device)" : ""}
              </span>
              {!c.current ? (
                <Button variant="ghost" onClick={() => void revoke(c.sessionId)}>
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Render it** — in `apps/web/src/routes/_chat.settings.tsx`, where sections are switched on, add a branch for `devices` that renders `<DevicesSettingsPanel />` inside the existing `SettingsSection`/`SettingsCard` wrappers (match the file's existing section-rendering pattern).

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck`
Expected: PASS.

```bash
git add apps/web/src/settingsNavigation.ts apps/web/src/routes/_chat.settings.tsx apps/web/src/components/hosts/DevicesSettingsPanel.tsx apps/web/src/wsNativeApi.ts packages/contracts apps/web/package.json package.json bun.lock
git commit -m "feat(web): add devices settings panel for pairing + device management"
```

### Task G4: Unreachable-host banner

**Files:**
- Create: `apps/web/src/components/hosts/HostConnectionBanner.tsx`
- Modify: `apps/web/src/routes/__root.tsx` (render banner near the app shell root)

**Interfaces:**
- Consumes: `useHostConnectionStatus` (G1), `useHostStore`, `switchActiveHost`, `LOCAL_HOST_ID`, `isElectron`.
- Produces: a non-blocking banner shown only when status is `unreachable`, offering "Retry" (reload) and, on desktop, "Switch to Local."

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/hosts/HostConnectionBanner.tsx
// FILE: HostConnectionBanner.tsx
// Purpose: Non-blocking banner when the active host is unreachable.
// Layer: Web component
// Exports: HostConnectionBanner

import { Button } from "../ui/button";
import { isElectron } from "../../env";
import { LOCAL_HOST_ID, useHostStore } from "../../hosts/hostStore";
import { switchActiveHost } from "../../hosts/switchActiveHost";
import { useHostConnectionStatus } from "../../hosts/useHostConnectionStatus";

export function HostConnectionBanner() {
  const status = useHostConnectionStatus();
  const active = useHostStore((s) => s.getActiveHost());
  if (status !== "unreachable" || active.kind === "local") return null;
  return (
    <div className="flex items-center justify-between gap-3 bg-red-500/10 px-3 py-2 text-sm text-red-600">
      <span>Can't reach {active.label}.</span>
      <span className="flex gap-2">
        <Button variant="ghost" onClick={() => window.location.reload()}>
          Retry
        </Button>
        {isElectron ? (
          <Button variant="ghost" onClick={() => switchActiveHost(LOCAL_HOST_ID)}>
            Switch to Local
          </Button>
        ) : null}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Render it** — in `apps/web/src/routes/__root.tsx`, render `<HostConnectionBanner />` at the top of the app shell layout (above the main content). Import it.

- [ ] **Step 3: Typecheck + commit**

Run: `bun run typecheck`
Expected: PASS.

```bash
git add apps/web/src/components/hosts/HostConnectionBanner.tsx apps/web/src/routes/__root.tsx
git commit -m "feat(web): add unreachable-host banner"
```

---

## Phase H — Hardening: revoked-credential handling + docs

### Task H1: Detect a revoked bearer and flag the host for re-pair

**Files:**
- Modify: `apps/web/src/hosts/hostConnection.ts` (surface 401s distinctly)
- Modify: `apps/web/src/hosts/hostStore.ts` (add a `needsRepair` flag + setter)
- Test: `apps/web/src/hosts/hostConnection.test.ts` (add case)

**Interfaces:**
- Produces: `RevokedHostCredentialError` thrown by `requestAuthJson` on `401`; `useHostStore` gains `markNeedsRepair(hostId, value: boolean)` and `Host.needsRepair?: boolean`.

- [ ] **Step 1: Write the failing test** — add to `apps/web/src/hosts/hostConnection.test.ts`

```typescript
it("throws RevokedHostCredentialError on 401", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  );
  const conn = makeHostConnection(remoteHost, { credentials: creds("BEARER123") });
  await expect(conn.requestAuthJson("/api/auth/session")).rejects.toThrow(/re-?pair/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/hosts/hostConnection.test.ts`
Expected: FAIL — generic Error, message doesn't match `/re-?pair/i`.

- [ ] **Step 3: Implement**

In `hostConnection.ts`, add:

```typescript
export class RevokedHostCredentialError extends Error {
  constructor(public readonly hostId: string) {
    super("This device's access was revoked — re-pair required.");
    this.name = "RevokedHostCredentialError";
  }
}
```

In `requestAuthJson`, before the generic error throw:

```typescript
if (response.status === 401 && host.kind === "remote") {
  throw new RevokedHostCredentialError(host.id);
}
```

In `hostStore.ts`, add `needsRepair?: boolean` to `Host` and a `markNeedsRepair(hostId, value)` action (mirror `markConnected`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/hosts/hostConnection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hosts/hostConnection.ts apps/web/src/hosts/hostStore.ts apps/web/src/hosts/hostConnection.test.ts
git commit -m "feat(web): flag hosts whose credential was revoked"
```

### Task H2: Update REMOTE.md for multi-host

**Files:**
- Modify: `REMOTE.md`

- [ ] **Step 1: Rewrite the doc** to describe: (1) running an always-on host (Mac Studio) bound to a Tailnet IP/MagicDNS name, which now prints a pairing link + QR at startup; (2) pairing the desktop app via "Add host → paste link"; (3) pairing the phone by opening the `/pair` link or pasting it; (4) switching the active host; (5) managing/revoking devices in Settings → Devices. Keep the existing CLI flag table.

- [ ] **Step 2: Commit**

```bash
git add REMOTE.md
git commit -m "docs: document multi-host pairing and host switching"
```

### Task H3: Final verification pass

- [ ] **Step 1: Run the full check suite**

```bash
bun run test
bun fmt
bun lint
bun typecheck
```

Expected: all pass. Fix any failures before finishing.

- [ ] **Step 2: Manual smoke (documented, not automated)**
  1. Start a server bound to a Tailnet IP with `--no-browser`; confirm the pairing banner + QR print.
  2. On the desktop app: Add host → paste the link → confirm switch + connect.
  3. From the desktop's Devices panel: generate a client link; open it on a phone on the tailnet; confirm the phone redeems and lands in the app.
  4. Switch back to Local on desktop; confirm local sessions are intact.
  5. Revoke the phone in Devices; confirm the phone shows the re-pair prompt on next request.

- [ ] **Step 3: Commit any fixes** from the verification pass with appropriate messages (no AI attribution).

---

## Notes & caveats (carry into execution)

- **TLS / mixed content:** A phone loading the app over `https://` from the host connects via `wss://` (same origin) — fine. The desktop at `t3://app` (privileged scheme) connects out to `http://`/`ws://` tailnet hosts; if Electron blocks that as mixed/insecure, prefer MagicDNS `https`/`wss` (Tailscale certs) or register the remote as a trusted bypass. Validate during H3 smoke; if blocked, add a small allowance in the desktop's `webPreferences`/CSP rather than weakening the server.
- **Dev mode origin:** in `VITE_DEV_SERVER_URL` mode the desktop renderer origin is the Vite URL, not `t3://app`; cross-origin to a *remote* host won't match that host's `devUrl`. This only affects local development against a remote host; production (`t3://app`) is fine. Don't spend effort here unless it blocks dev.
- **Owner vs client role:** the startup link grants **owner**; the Devices "Generate pairing link" grants **client**. Only owner devices can open the Devices panel's generate/revoke actions (server enforces 403). Surface that gracefully (hide/disable generate when the active session role isn't owner — read role from `getAuthSession()`).
- **Phone first-add bootstrap:** the very first phone connection is the `/pair` link from the host's startup banner or the desktop's Devices panel; there is no discovery on the phone (by design).
