import { describe, expect, it } from "vitest";

import { formatStartupPairingBanner } from "./startupPairingBanner";

describe("formatStartupPairingBanner", () => {
  it("includes the pairing URL and the QR block", () => {
    const banner = formatStartupPairingBanner({
      pairingUrl: "https://studio.ts.net:3773/pair#token=ABCD1234WXYZ",
      qr: "█▀▀▀▀▀█",
    });
    expect(banner).toContain("https://studio.ts.net:3773/pair#token=ABCD1234WXYZ");
    expect(banner).toContain("█▀▀▀▀▀█");
    expect(banner).toContain("Pair a device");
  });
});
