# Remote Access & Multi-Host Setup

Use this when you want to reach Synara from another device — a phone, a laptop,
another desktop — or when you're running an always-on host (e.g. a Mac Studio)
that several clients connect to.

Synara's client can hold several **hosts** and switch the active one from the
sidebar. Pairing a device gives it its own durable, individually revocable
credential — no shared secret to copy around. Agent sessions keep running on
the host after you switch away, so switching back just resumes them.

## CLI ↔ Env option map

The Synara CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `T3CODE_MODE`         | Runtime mode.                      |
| `--port <number>`       | `T3CODE_PORT`         | HTTP/WebSocket port.               |
| `--host <address>`      | `T3CODE_HOST`         | Bind interface/address.            |
| `--home-dir <path>`     | `SYNARA_HOME`         | Base directory.                    |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `T3CODE_NO_BROWSER`   | Disable auto-open browser.         |
| `--auth-token <token>`  | `T3CODE_AUTH_TOKEN`   | WebSocket auth token.              |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
- Treat the token like a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.
- When a host is reachable from outside loopback, it also becomes pairable (see below): any device that redeems a pairing link gets its own bearer credential, individually revocable from **Settings → Devices**. The tailnet (or LAN) is still the trust boundary — bearer credentials are defense-in-depth, not a substitute for binding to a trusted interface.

## 1) Build + run server for remote access

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open on your phone:

`http://<your-machine-ip>:3773`

Example:

`http://192.168.1.42:3773`

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- `--no-browser` prevents local auto-open, which is usually better for headless/remote sessions.
- Ensure your OS firewall allows inbound TCP on the selected port.
- Because this binds to a non-loopback address, the server also prints a pairing banner at startup — see [Pairing a new device](#3-pairing-a-new-device) below. That's usually the easier way to get a phone or a second desktop connected, since it hands out a per-device credential instead of the shared `--auth-token`.

## 2) Tailnet / Tailscale access

If you use Tailscale, you can bind directly to your Tailnet address.

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773`

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.

This is the recommended shape for an always-on host (e.g. a Mac Studio): bind
to its Tailnet IP or MagicDNS name, run with `--no-browser`, and let devices
pair in as described below.

```bash
bun run --cwd apps/server start -- --host <tailnet-ip-or-magicdns-name> --port 3773 --no-browser
```

## 3) Pairing a new device

Whenever the server is reachable from outside loopback (bound to a Tailnet
IP, LAN IP, or `0.0.0.0`), it prints a **pairing banner** to the terminal at
startup — a link and a QR code, regardless of whether `--no-browser` is set:

```
Pair a device with this Synara host:

<QR code>

  https://<host>/pair#token=<one-time-credential>

Open the link on the device, or paste it into Add host. Expires shortly.
```

This is the headless pairing surface — there's no separate `synara pair`
subcommand; starting the host in remote-reachable mode is enough to get a
pairing link. The one-time credential in the link's fragment (`#token=…`)
expires shortly, so pair devices soon after startup, or mint a fresh link
later from **Settings → Devices** (see below) once you're already paired in.

### Add a host from a client (desktop app or phone)

Open the sidebar **host switcher** (top of the sidebar) → **Add host…** →
paste the pairing link. The client redeems it for a durable, per-device
bearer credential and switches to that host. This works the same way on
desktop and on mobile — paste-link is the universal path.

### Phone shortcut

On a phone you don't need to paste anything: just open the pairing link
directly (scan the QR code, or tap the link if it arrived some other way).
That opens the host's `/pair` page, which redeems the link and drops you
straight into the app, now connected to that host.

### Install to your home screen (PWA)

The web client is a progressive web app, so once you've opened it on a phone
(or any browser) you can install it as a standalone app instead of living in a
browser tab:

- **iOS Safari** — Share → **Add to Home Screen**.
- **Android Chrome** — the **Install app** prompt, or ⋮ menu → **Install app / Add to Home screen**.
- **Desktop Chrome/Edge** — the install icon in the address bar.

Installability needs the built web app served over the network (the remote
setup above), not the local Vite dev redirect. The launched app runs
standalone (no browser chrome) and reconnects to whatever host you last had
active. Your paired host credentials persist across launches.

## 4) Switching the active host

The **host switcher** in the sidebar header shows the active host's label and
a connection status dot (connected / connecting / unreachable). Open it to
see every host you've added — the pinned `Local` host (desktop app only) plus
any paired remotes — and pick one to make it active. The whole UI reconnects
to reflect the newly active host.

Only one host is active at a time, and switching triggers a brief reconnect.
Nothing stops on the host you switch away from — agent sessions keep running
there, so switching back just resumes them.

## 5) Managing devices

**Settings → Devices** (owner devices only) is where you manage pairing after
the fact:

- **Generate pairing link** — mints a fresh one-time link and QR code, the
  same kind printed at startup, for onboarding another device.
- **Paired devices** — lists every device that has redeemed a pairing link for
  this host, with last-seen/connected status, and lets you **revoke** any of
  them individually.

## 6) Local host (desktop only)

The desktop app always has a `Local` host pinned at the top of the switcher.
It uses loopback and needs no pairing — it's unaffected by anything above.

## Credentials & security

- Remote hosts authenticate devices with **per-device bearer tokens** issued
  by pairing. Each one is individually revocable from Settings → Devices on
  that host.
- The bearer is stored in the OS keychain on desktop (via Electron's secure
  storage) and in browser storage on mobile/web.
- WebSocket connections use a separate, short-lived **ws-token** fetched with
  the bearer; the durable bearer itself never travels on the socket URL.
- Keep binding to the tailnet or loopback, not a public `0.0.0.0` — the
  tailnet remains the trust boundary, and per-device bearer credentials are
  defense-in-depth on top of it.
