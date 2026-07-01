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
  const payload = (await response.json().catch(() => null)) as {
    sessionToken?: string;
    error?: string;
  } | null;
  if (!response.ok || !payload?.sessionToken) {
    throw new Error(payload?.error ?? "Pairing failed. The link may have expired.");
  }

  const host = useHostStore
    .getState()
    .addRemoteHost({ label: deps?.label ?? "", baseUrl: parsed.baseUrl });
  await credentials.set(host.id, payload.sessionToken);
  return host;
}
