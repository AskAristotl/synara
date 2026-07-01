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

  it("omits the reachability warning when reachable is true or unset", () => {
    const banner = formatStartupPairingBanner({
      pairingUrl: "http://100.101.102.103:3773/pair#token=ABCD1234WXYZ",
      qr: "█▀▀▀▀▀█",
      reachable: true,
    });
    expect(banner).not.toContain("Warning");
  });

  it("appends a reachability warning when reachable is false", () => {
    const banner = formatStartupPairingBanner({
      pairingUrl: "http://localhost:3773/pair#token=ABCD1234WXYZ",
      qr: "█▀▀▀▀▀█",
      reachable: false,
    });
    expect(banner).toContain("Warning");
    expect(banner).toContain("will NOT be reachable from other devices");
  });
});
