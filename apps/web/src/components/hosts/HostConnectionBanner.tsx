// apps/web/src/components/hosts/HostConnectionBanner.tsx
// FILE: HostConnectionBanner.tsx
// Purpose: Non-blocking banner shown when the active remote host is unreachable.
// Layer: Web component
// Exports: HostConnectionBanner

import { isElectron } from "../../env";
import { LOCAL_HOST_ID, useHostStore } from "../../hosts/hostStore";
import { switchActiveHost } from "../../hosts/switchActiveHost";
import { useHostConnectionStatus } from "../../hosts/useHostConnectionStatus";
import { Button } from "../ui/button";

/** Non-blocking banner for when the active host is unreachable. Renders nothing
 * for the local host — only remote hosts can be "unreachable" in a way the user
 * needs to act on. Offers a reload retry and, on desktop, a fallback to Local. */
export function HostConnectionBanner() {
  const status = useHostConnectionStatus();
  const active = useHostStore((state) => state.getActiveHost());

  if (status !== "unreachable" || active.kind === "local") return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-red-500/10 px-3 py-2 text-red-600 text-sm">
      <span>Can't reach {active.label}.</span>
      <span className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
          Retry
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
