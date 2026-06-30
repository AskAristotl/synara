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
