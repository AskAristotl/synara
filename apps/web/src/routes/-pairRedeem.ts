// apps/web/src/routes/-pairRedeem.ts
// FILE: -pairRedeem.ts
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
    const host = await redeemPairingLink(
      href,
      deps?.credentials ? { credentials: deps.credentials } : undefined,
    );
    useHostStore.getState().setActiveHostId(host.id);
    return { ok: true, hostId: host.id };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Pairing failed." };
  }
}
