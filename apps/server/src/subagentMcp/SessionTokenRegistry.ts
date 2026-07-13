/**
 * SessionTokenRegistry - Identity backbone for the sub-agent MCP endpoint.
 *
 * A shared in-memory registry that mints per-session bearer tokens and
 * resolves them back to a caller identity (`threadId` + `canSpawn`). The
 * sub-agent MCP transport (Phase 2/3) authenticates every request through a
 * token minted here rather than trusting a client-supplied `threadId`
 * directly, so a caller can only ever act as the thread it was issued for.
 *
 * Tokens are cryptographically random and NOT derivable from the threadId
 * they map to (see `issueToken`). They are process-lifetime only: nothing is
 * persisted, so a server restart invalidates every outstanding token (callers
 * must re-authenticate / be re-issued a token on session start).
 *
 * @module SessionTokenRegistry
 */
import * as Crypto from "node:crypto";

import type { ThreadId } from "@synara/contracts";
import { Effect, Layer, Option, Ref, ServiceMap } from "effect";

/** Byte length of the random token payload before hex-encoding (256 bits). */
const TOKEN_BYTE_LENGTH = 32;

/** Caller identity resolved from a bearer token. */
export interface SessionTokenIdentity {
  readonly threadId: ThreadId;
  readonly canSpawn: boolean;
}

export interface SessionTokenRegistryShape {
  /**
   * Mint a new opaque bearer token bound to `threadId`, storing `canSpawn`
   * alongside it. The token is a cryptographically-random hex string with no
   * structural relationship to `threadId` — it cannot be guessed or derived
   * from the thread it authenticates.
   */
  readonly issueToken: (
    threadId: ThreadId,
    opts: { readonly canSpawn: boolean },
  ) => Effect.Effect<string>;

  /** Look up a token's caller identity. `Option.none()` if unknown or revoked. */
  readonly resolve: (token: string) => Effect.Effect<Option.Option<SessionTokenIdentity>>;

  /**
   * Revoke every token issued for `threadId`. A thread may have been issued
   * more than one token across restarts/reconnects, so this clears all of
   * them, not just the most recent.
   */
  readonly revoke: (threadId: ThreadId) => Effect.Effect<void>;
}

export class SessionTokenRegistry extends ServiceMap.Service<
  SessionTokenRegistry,
  SessionTokenRegistryShape
>()("t3/subagentMcp/SessionTokenRegistry") {}

const generateToken = (): string => Crypto.randomBytes(TOKEN_BYTE_LENGTH).toString("hex");

export const SessionTokenRegistryLive = Layer.effect(
  SessionTokenRegistry,
  Effect.gen(function* () {
    const tokensRef = yield* Ref.make(new Map<string, SessionTokenIdentity>());

    const issueToken: SessionTokenRegistryShape["issueToken"] = (threadId, opts) =>
      Ref.modify(tokensRef, (current) => {
        const token = generateToken();
        const next = new Map(current);
        next.set(token, { threadId, canSpawn: opts.canSpawn });
        return [token, next] as const;
      });

    const resolve: SessionTokenRegistryShape["resolve"] = (token) =>
      Ref.get(tokensRef).pipe(Effect.map((current) => Option.fromUndefinedOr(current.get(token))));

    const revoke: SessionTokenRegistryShape["revoke"] = (threadId) =>
      Ref.update(tokensRef, (current) => {
        const next = new Map(current);
        for (const [token, identity] of current) {
          if (identity.threadId === threadId) {
            next.delete(token);
          }
        }
        return next;
      });

    return { issueToken, resolve, revoke } satisfies SessionTokenRegistryShape;
  }),
);
