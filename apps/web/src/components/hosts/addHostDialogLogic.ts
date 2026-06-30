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
