// FILE: appCors.ts
// Purpose: Cross-origin response headers for Synara's bearer-token-authenticated
//          app routes (e.g. a phone browser on origin A pairing/connecting to a
//          different host B, or the desktop app at t3://app connecting to a
//          remote host).
// Layer: Server HTTP/security utility
// Exports: appCorsHeaders, CORS_ALLOWED_METHODS, CORS_ALLOWED_HEADERS

import type { ServerConfigShape } from "./config";
import { normalizeCorsOrigin } from "./trustedOrigins";

export const CORS_ALLOWED_METHODS = "GET, POST, OPTIONS";
export const CORS_ALLOWED_HEADERS = "Authorization, Content-Type";

// Deliberately broad: these routes are driven by BEARER credentials
// (Authorization header, or a SameSite=Lax session cookie that browsers
// already withhold from cross-origin fetch/XHR — the only request kind CORS
// governs). Nothing a browser attaches automatically rides along on a
// cross-origin call here, so reflecting *any* Origin carries none of the
// CSRF/credential-theft risk a normal ambient-cookie CORS policy would have —
// a malicious page can read the response, but it never had the caller's
// credential to send in the first place. This intentionally supports
// multi-host pairing, e.g. a phone browser on origin A connecting/pairing to
// a different host B.
//
// The invariant that keeps this safe is that we NEVER emit
// `Access-Control-Allow-Credentials`. Without it, browsers withhold
// credentialed responses from the reflected origin even for a
// `credentials: "include"` request, so broadening this to any origin cannot
// leak session state to a page that couldn't already read it. Do not add
// that header here.
export function appCorsHeaders(input: {
  readonly rawOrigin: string | ReadonlyArray<string> | undefined;
  readonly requestOrigin: string;
  readonly config: ServerConfigShape;
}): Record<string, string> {
  const origin = normalizeCorsOrigin(input.rawOrigin);
  if (!origin || origin === input.requestOrigin) {
    // Missing origin, or same-origin requests, need no CORS headers.
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    Vary: "Origin",
  };
}
