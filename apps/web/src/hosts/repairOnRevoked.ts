// apps/web/src/hosts/repairOnRevoked.ts
// FILE: repairOnRevoked.ts
// Purpose: Pure helper wrapping a socket-URL resolver so a revoked remote
//          credential marks its host as needing re-pair before rethrowing.
// Layer: Web transport
// Exports: wrapResolverForRepair

import { RevokedHostCredentialError } from "./hostConnection";

/**
 * Wraps a socket-URL resolver so that a `RevokedHostCredentialError` marks
 * the offending host as needing re-pair (via `onRevoked`) before the error is
 * rethrown. All other errors — and successful resolutions — pass through
 * unchanged.
 */
export function wrapResolverForRepair(
  resolve: () => Promise<string>,
  onRevoked: (hostId: string) => void,
): () => Promise<string> {
  return async () => {
    try {
      return await resolve();
    } catch (error) {
      if (error instanceof RevokedHostCredentialError) {
        onRevoked(error.hostId);
      }
      throw error;
    }
  };
}
