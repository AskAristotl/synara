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

  it("returns no headers for an untrusted origin", () => {
    const headers = appCorsHeaders({
      rawOrigin: "https://evil.example.com",
      requestOrigin: "https://studio.tailnet.ts.net:3773",
      config,
    });
    expect(headers).toEqual({});
  });

  it("returns no headers when no Origin is present", () => {
    expect(appCorsHeaders({ rawOrigin: undefined, requestOrigin: "https://x", config })).toEqual(
      {},
    );
  });
});
