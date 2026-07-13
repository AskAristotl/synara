// apps/web/src/components/hosts/DevicesSettingsPanel.tsx
// FILE: DevicesSettingsPanel.tsx
// Purpose: Settings → Devices panel. Generates a one-time pairing link + QR code for
// onboarding another device to this host, and lists/revokes already-paired client
// sessions (owner-only server endpoints; a 403 there surfaces inline).
// Layer: Web component
// Exports: DevicesSettingsPanel

import type { AuthClientSession } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { SettingsListRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { CheckIcon, CopyIcon, Loader2Icon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import {
  serverAuthClientsQueryOptions,
  serverRevokeAuthClientMutationOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { SETTINGS_CARD_ROW_CLASS_NAME } from "~/settingsPanelStyles";

/**
 * `AuthClientSession`'s timestamp fields are typed as Effect `DateTime.Utc` (the schema's
 * decoded representation), but `requestAuthJson` never runs the payload through a schema
 * decoder — it's a plain `response.json()` cast to the contract type. Over the wire they
 * arrive as ISO strings, so this treats the value defensively instead of trusting the type.
 */
function toDateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "object" && "toJSON" in value) {
    const json = (value as { toJSON: () => unknown }).toJSON();
    return typeof json === "string" ? toDateOrNull(json) : null;
  }
  return null;
}

function formatClientLabel(client: AuthClientSession): string {
  if (client.client.label) return client.client.label;
  const parts = [client.client.browser, client.client.os].filter((part): part is string =>
    Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : client.subject;
}

function formatLastSeen(client: AuthClientSession): string {
  if (client.connected) return "Connected now";
  const lastSeen = toDateOrNull(client.lastConnectedAt);
  if (!lastSeen) return "Never connected";
  const relative = formatRelativeTime(lastSeen.toISOString());
  return relative === "now" ? "Last seen just now" : `Last seen ${relative} ago`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function DevicesSettingsPanel() {
  const queryClient = useQueryClient();
  const clientsQuery = useQuery(serverAuthClientsQueryOptions());
  const revokeMutation = useMutation(serverRevokeAuthClientMutationOptions({ queryClient }));

  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!pairingUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    setQrError(null);
    QRCode.toDataURL(pairingUrl, { margin: 1, width: 220 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setQrDataUrl(null);
        setQrError(errorMessage(error, "Failed to render the QR code."));
      });
    return () => {
      cancelled = true;
    };
  }, [pairingUrl]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const generateLink = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const { url } = await ensureNativeApi().server.createAuthPairingUrl();
      setPairingUrl(url);
      setCopied(false);
    } catch (error) {
      setGenerateError(errorMessage(error, "Failed to create a pairing link."));
    } finally {
      setGenerating(false);
    }
  };

  const copyLink = async () => {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopied(true);
    } catch {
      // Clipboard permission denied or unavailable; the link is still visible/selectable.
    }
  };

  const clients = clientsQuery.data ?? [];
  const clientsErrorText = clientsQuery.isError
    ? errorMessage(clientsQuery.error, "Failed to load paired devices.")
    : null;
  const revokeErrorText = revokeMutation.isError
    ? errorMessage(revokeMutation.error, "Failed to revoke that device.")
    : null;

  return (
    <div className="space-y-6">
      <SettingsSection title="Pair a new device">
        <div className="space-y-3 p-4">
          <p className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
            Generate a one-time link (and QR code) to sign a new device into this host. Anyone with
            the link can pair, so keep it private and generate a fresh one per device.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={generating}
            onClick={() => void generateLink()}
          >
            {generating ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Generate pairing link
          </Button>
          {generateError ? <p className="text-destructive text-xs">{generateError}</p> : null}
          {pairingUrl ? (
            <div className="flex flex-col items-start gap-3 sm:flex-row">
              {qrDataUrl ? (
                <img
                  alt="Pairing QR code"
                  src={qrDataUrl}
                  className="size-40 shrink-0 rounded-lg border border-[color:var(--color-border)] bg-white p-2"
                />
              ) : null}
              <div className="min-w-0 flex-1 space-y-2">
                <Input
                  readOnly
                  size="sm"
                  value={pairingUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button size="xs" variant="ghost" onClick={() => void copyLink()}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                {qrError ? <p className="text-destructive text-xs">{qrError}</p> : null}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title="Paired devices">
        {clientsQuery.isPending ? (
          <div className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "text-muted-foreground text-xs")}>
            Loading devices…
          </div>
        ) : clientsErrorText ? (
          <div className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "text-destructive text-xs")}>
            {clientsErrorText}
          </div>
        ) : clients.length === 0 ? (
          <div className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "text-muted-foreground text-xs")}>
            No paired devices yet.
          </div>
        ) : (
          clients.map((client) => (
            <SettingsListRow
              key={client.sessionId}
              title={
                <span className="flex items-center gap-1.5">
                  {formatClientLabel(client)}
                  {client.current ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      This device
                    </span>
                  ) : null}
                </span>
              }
              description={formatLastSeen(client)}
              actions={
                client.current ? null : (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={
                      revokeMutation.isPending &&
                      revokeMutation.variables?.sessionId === client.sessionId
                    }
                    onClick={() => revokeMutation.mutate({ sessionId: client.sessionId })}
                  >
                    Revoke
                  </Button>
                )
              }
            />
          ))
        )}
        {revokeErrorText ? (
          <p className="px-2 text-destructive text-xs">{revokeErrorText}</p>
        ) : null}
      </SettingsSection>
    </div>
  );
}
