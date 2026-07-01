// apps/web/src/components/hosts/HostSwitcher.tsx
// FILE: HostSwitcher.tsx
// Purpose: Sidebar-header dropdown for switching the active Synara host, adding a
// new host, or jumping to device management in settings.
// Layer: Web component

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { isElectron } from "../../env";
import type { HostConnectionStatus } from "../../hosts/hostConnectionStatus";
import { LOCAL_HOST_ID, useHostStore } from "../../hosts/hostStore";
import { switchActiveHost } from "../../hosts/switchActiveHost";
import { useHostConnectionStatus } from "../../hosts/useHostConnectionStatus";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { AddHostDialog } from "./AddHostDialog";

const STATUS_DOT_CLASS_NAME: Record<HostConnectionStatus, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  unreachable: "bg-red-500",
};

/** Active-host switcher for the sidebar header: shows the active host + connection
 * status, and lets the user switch hosts, add a new one, or manage devices. */
export function HostSwitcher() {
  const navigate = useNavigate();
  const hosts = useHostStore((state) => state.hosts);
  const activeHostId = useHostStore((state) => state.activeHostId);
  const status = useHostConnectionStatus();
  const [addHostOpen, setAddHostOpen] = useState(false);

  const activeHost = hosts.find((host) => host.id === activeHostId);
  // The browser has no local host to switch to; hostStore always seeds `hosts`
  // with the local host first, so no extra sorting is needed for the Electron case.
  const visibleHosts = isElectron ? hosts : hosts.filter((host) => host.id !== LOCAL_HOST_ID);

  return (
    <>
      <Menu>
        <MenuTrigger
          className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[length:var(--app-font-size-ui,12px)] font-medium text-muted-foreground/85 hover:bg-[var(--sidebar-accent)] hover:text-foreground"
          aria-label="Switch host"
        >
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0 rounded-full", STATUS_DOT_CLASS_NAME[status])}
          />
          <span className="truncate">{activeHost?.label ?? "Local"}</span>
        </MenuTrigger>
        <MenuPopup
          align="start"
          className="min-w-56 rounded-lg border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] shadow-lg"
        >
          {visibleHosts.map((host) => (
            <MenuItem key={host.id} onClick={() => switchActiveHost(host.id)}>
              <span className="min-w-0 flex-1 truncate">{host.label}</span>
              {host.needsRepair ? (
                <span
                  className="shrink-0 text-[length:var(--app-font-size-ui-small,11px)] text-amber-500"
                  title="Needs re-pairing — access was revoked"
                >
                  Needs re-pair
                </span>
              ) : null}
              {host.id === activeHostId ? <span aria-hidden="true">✓</span> : null}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => setAddHostOpen(true)}>Add host…</MenuItem>
          <MenuItem
            onClick={() => {
              void navigate({ to: "/settings", search: { section: "devices" } });
            }}
          >
            Manage devices…
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AddHostDialog open={addHostOpen} onOpenChange={setAddHostOpen} />
    </>
  );
}
