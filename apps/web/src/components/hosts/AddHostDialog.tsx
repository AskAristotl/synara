// apps/web/src/components/hosts/AddHostDialog.tsx
// FILE: AddHostDialog.tsx
// Purpose: Paste-a-pairing-link dialog to add a remote host (desktop + mobile).
// Layer: Web component

import { useEffect, useState } from "react";

import { redeemPairingLink } from "../../hosts/pairing";
import { switchActiveHost } from "../../hosts/switchActiveHost";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { validateAddHostInput } from "./addHostDialogLogic";

export interface AddHostDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddHostDialog({ open, onOpenChange }: AddHostDialogProps) {
  const [link, setLink] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Clear stale state left over from a cancelled or failed attempt so a reopen starts clean.
  useEffect(() => {
    if (!open) {
      setLink("");
      setLabel("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a host</DialogTitle>
          <DialogDescription>
            Paste the pairing link shown on the host you want to connect to.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="font-medium text-foreground text-xs">Pairing link</span>
            <Input
              placeholder="https://…/pair#token=…"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              autoFocus
            />
          </label>
          <label className="grid gap-1.5">
            <span className="font-medium text-foreground text-xs">Name (optional)</span>
            <Input
              placeholder="Mac Studio"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void submit();
            }}
            disabled={busy}
          >
            {busy ? "Pairing…" : "Add host"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
