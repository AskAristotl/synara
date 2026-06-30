// FILE: appCors.ts
// Purpose: Cross-origin response headers for trusted Synara app surfaces
//          (e.g. the desktop app at t3://app connecting to a remote host).
// Layer: Server HTTP/security utility
// Exports: appCorsHeaders, CORS_ALLOWED_METHODS, CORS_ALLOWED_HEADERS

import type { ServerConfigShape } from "./config";
import { isTrustedAppOrigin, normalizeCorsOrigin } from "./trustedOrigins";

export const CORS_ALLOWED_METHODS = "GET, POST, OPTIONS";
export const CORS_ALLOWED_HEADERS = "Authorization, Content-Type";

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
  if (!isTrustedAppOrigin({ origin, requestOrigin: input.requestOrigin, config: input.config })) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    Vary: "Origin",
  };
}
