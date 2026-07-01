// FILE: startupPairingBanner.ts
// Purpose: Format the headless pairing banner (link + QR) shown at startup.
// Layer: Server startup utility
// Exports: formatStartupPairingBanner, renderPairingQr

import QRCode from "qrcode";

export function formatStartupPairingBanner(input: {
  readonly pairingUrl: string;
  readonly qr: string;
  /**
   * Set to false when the pairing URL's host could not be resolved to an
   * externally-reachable address (e.g. bound to a wildcard host with no
   * usable network interface), so it fell back to localhost. Appends a
   * warning telling the user the link won't work from another device.
   */
  readonly reachable?: boolean;
}): string {
  const lines = [
    "",
    "  Pair a device with this Synara host:",
    "",
    input.qr,
    `  ${input.pairingUrl}`,
    "",
    "  Open the link on the device, or paste it into Add host. Expires shortly.",
  ];
  if (input.reachable === false) {
    lines.push(
      "",
      "  Warning: bound to a wildcard address with no reachable network interface found,",
      "  so this link uses localhost and will NOT be reachable from other devices.",
      "  Bind to a concrete Tailnet/LAN IP (e.g. --host 100.x.x.x) to fix this.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderPairingQr(pairingUrl: string): Promise<string> {
  return QRCode.toString(pairingUrl, { type: "terminal", small: true });
}
