import { describe, expect, it } from "vitest";

import { appCorsHeaders } from "./appCors";
import type { ServerConfigShape } from "./config";

const config = { host: "0.0.0.0", mode: "web" } as unknown as ServerConfigShape;

describe("appCorsHeaders", () => {
  it("emits CORS headers for the trusted desktop origin", () => {
    const headers = appCorsHeaders({
      rawOrigin: "t3://app",
      requestOrigin: "https://studio.tailnet.ts.net:3773",
      config,
    });
    expect(headers["Access-Control-Allow-Origin"]).toBe("t3://app");
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(headers.Vary).toBe("Origin");
  });

  it("reflects a cross-origin request (multi-host client on a different origin)", () => {
    const headers = appCorsHeaders({
      rawOrigin: "https://phone.example",
      requestOrigin: "https://studio.tailnet.ts.net:3773",
      config,
    });
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://phone.example");
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(headers.Vary).toBe("Origin");
  });

  it("returns no headers when no Origin is present", () => {
    expect(appCorsHeaders({ rawOrigin: undefined, requestOrigin: "https://x", config })).toEqual(
      {},
    );
  });

  it("returns no headers for same-origin requests", () => {
    expect(
      appCorsHeaders({
        rawOrigin: "https://studio.tailnet.ts.net:3773",
        requestOrigin: "https://studio.tailnet.ts.net:3773",
        config,
      }),
    ).toEqual({});
  });

  it("never emits Access-Control-Allow-Credentials (bearer-only auth, no ambient cookies)", () => {
    const headers = appCorsHeaders({
      rawOrigin: "https://phone.example",
      requestOrigin: "https://studio.tailnet.ts.net:3773",
      config,
    });
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();

    const trustedHeaders = appCorsHeaders({
      rawOrigin: "t3://app",
      requestOrigin: "https://studio.tailnet.ts.net:3773",
      config,
    });
    expect(trustedHeaders["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});
