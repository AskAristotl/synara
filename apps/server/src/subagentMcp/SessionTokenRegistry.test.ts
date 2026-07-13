import { ThreadId } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { SessionTokenRegistry, SessionTokenRegistryLive } from "./SessionTokenRegistry.ts";

const runWithRegistry = <A, E>(effect: Effect.Effect<A, E, SessionTokenRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SessionTokenRegistryLive)));

const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");

describe("SessionTokenRegistry", () => {
  it("resolves an issued token to its threadId and canSpawn:true", async () => {
    const identity = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* SessionTokenRegistry;
        const token = yield* registry.issueToken(threadA, { canSpawn: true });
        return yield* registry.resolve(token);
      }),
    );

    expect(Option.isSome(identity)).toBe(true);
    expect(Option.getOrThrow(identity)).toEqual({ threadId: threadA, canSpawn: true });
  });

  it("resolves an issued token to its threadId and canSpawn:false", async () => {
    const identity = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* SessionTokenRegistry;
        const token = yield* registry.issueToken(threadA, { canSpawn: false });
        return yield* registry.resolve(token);
      }),
    );

    expect(Option.isSome(identity)).toBe(true);
    expect(Option.getOrThrow(identity)).toEqual({ threadId: threadA, canSpawn: false });
  });

  it("mints distinct tokens for two separate issues", async () => {
    const [tokenOne, tokenTwo] = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* SessionTokenRegistry;
        const tokenOne = yield* registry.issueToken(threadA, { canSpawn: true });
        const tokenTwo = yield* registry.issueToken(threadB, { canSpawn: true });
        return [tokenOne, tokenTwo] as const;
      }),
    );

    expect(tokenOne).not.toBe(tokenTwo);
    // Opaque: the token must not be (or trivially contain) the threadId itself.
    expect(tokenOne).not.toContain("thread-a");
    expect(tokenTwo).not.toContain("thread-b");
  });

  it("resolves an unknown token to Option.none()", async () => {
    const identity = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* SessionTokenRegistry;
        return yield* registry.resolve("not-a-real-token");
      }),
    );

    expect(Option.isNone(identity)).toBe(true);
  });

  it("invalidates a thread's token after revoke", async () => {
    const identity = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* SessionTokenRegistry;
        const token = yield* registry.issueToken(threadA, { canSpawn: true });
        yield* registry.revoke(threadA);
        return yield* registry.resolve(token);
      }),
    );

    expect(Option.isNone(identity)).toBe(true);
  });

  it("revoking one thread does not invalidate another thread's token", async () => {
    const [identityA, identityB] = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* SessionTokenRegistry;
        const tokenA = yield* registry.issueToken(threadA, { canSpawn: true });
        const tokenB = yield* registry.issueToken(threadB, { canSpawn: false });
        yield* registry.revoke(threadA);
        const identityA = yield* registry.resolve(tokenA);
        const identityB = yield* registry.resolve(tokenB);
        return [identityA, identityB] as const;
      }),
    );

    expect(Option.isNone(identityA)).toBe(true);
    expect(Option.isSome(identityB)).toBe(true);
    expect(Option.getOrThrow(identityB)).toEqual({ threadId: threadB, canSpawn: false });
  });

  it("revoke removes ALL tokens issued for a thread across multiple issues", async () => {
    const [identityOne, identityTwo] = await runWithRegistry(
      Effect.gen(function* () {
        const registry = yield* SessionTokenRegistry;
        const tokenOne = yield* registry.issueToken(threadA, { canSpawn: true });
        const tokenTwo = yield* registry.issueToken(threadA, { canSpawn: true });
        yield* registry.revoke(threadA);
        const identityOne = yield* registry.resolve(tokenOne);
        const identityTwo = yield* registry.resolve(tokenTwo);
        return [identityOne, identityTwo] as const;
      }),
    );

    expect(Option.isNone(identityOne)).toBe(true);
    expect(Option.isNone(identityTwo)).toBe(true);
  });
});
