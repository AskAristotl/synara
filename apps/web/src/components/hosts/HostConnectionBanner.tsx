// apps/web/src/components/hosts/HostConnectionBanner.tsx
// FILE: HostConnectionBanner.tsx
// Purpose: Non-blocking banner shown when the active remote host is unreachable,
//          or needs re-pairing because its credential was revoked.
// Layer: Web component
// Exports: HostConnectionBanner

import { useState } from "react";

import { isElectron } from "../../env";
import { requestTransportReconnect } from "../../wsNativeApi";
import { LOCAL_HOST_ID, useHostStore } from "../../hosts/hostStore";
import { switchActiveHost } from "../../hosts/switchActiveHost";
import { useHostConnectionStatus } from "../../hosts/useHostConnectionStatus";
import { Button } from "../ui/button";
import { AddHostDialog } from "./AddHostDialog";

/** Non-blocking banner for when the active host is unreachable, or needs
 * re-pairing because its credential was revoked. Renders nothing for the
 * local host — only remote hosts can be in either state. The re-pair state
 * takes precedence over the plain "unreachable" state, since re-pairing is
 * the actionable fix (retrying alone can't succeed with a revoked
 * credential). */
export function HostConnectionBanner() {
  const status = useHostConnectionStatus();
  const active = useHostStore((state) => state.getActiveHost());
  const [repairOpen, setRepairOpen] = useState(false);

  if (active.kind === "local") return null;

  if (active.needsRepair) {
    return (
      <>
        <div className="flex items-center justify-between gap-3 bg-amber-500/10 px-3 py-2 text-amber-600 text-sm">
          <span>{active.label} needs re-pairing — its access was revoked.</span>
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRepairOpen(true)}>
              Re-pair
            </Button>
            {isElectron ? (
              <Button variant="ghost" size="sm" onClick={() => switchActiveHost(LOCAL_HOST_ID)}>
                Switch to Local
              </Button>
            ) : null}
          </span>
        </div>
        <AddHostDialog open={repairOpen} onOpenChange={setRepairOpen} />
      </>
    );
  }

  if (status !== "unreachable") return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-red-500/10 px-3 py-2 text-red-600 text-sm">
      <span>Can't reach {active.label}. Retrying automatically…</span>
      <span className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => requestTransportReconnect()}>
          Retry now
        </Button>
        {isElectron ? (
          <Button variant="ghost" size="sm" onClick={() => switchActiveHost(LOCAL_HOST_ID)}>
            Switch to Local
          </Button>
        ) : null}
      </span>
    </div>
  );
}
