// FILE: wsOriginPolicy.test.ts
// Purpose: Pins that the /ws origin (CSRF) gate can only be bypassed by a
//          VALIDATED credential, never by mere token presence.
// Layer: Server utility tests

import { describe, expect, it } from "vitest";

import { shouldRejectWsUpgrade } from "./wsOriginPolicy";

describe("shouldRejectWsUpgrade", () => {
  it("rejects a garbage/invalid token from an untrusted origin (the exploit case)", () => {
    expect(
      shouldRejectWsUpgrade({
        legacyAuthorized: false,
        wsTokenValidated: false,
        originUntrusted: true,
      }),
    ).toBe(true);
  });

  it("allows a validated token from an untrusted origin (legit cross-origin multi-host)", () => {
    expect(
      shouldRejectWsUpgrade({
        legacyAuthorized: false,
        wsTokenValidated: true,
        originUntrusted: true,
      }),
    ).toBe(false);
  });

  it("allows no token from a trusted origin", () => {
    expect(
      shouldRejectWsUpgrade({
        legacyAuthorized: false,
        wsTokenValidated: false,
        originUntrusted: false,
      }),
    ).toBe(false);
  });

  it("rejects no token from an untrusted origin", () => {
    expect(
      shouldRejectWsUpgrade({
        legacyAuthorized: false,
        wsTokenValidated: false,
        originUntrusted: true,
      }),
    ).toBe(true);
  });

  it("allows a legacy-authorized shared secret from an untrusted origin", () => {
    expect(
      shouldRejectWsUpgrade({
        legacyAuthorized: true,
        wsTokenValidated: false,
        originUntrusted: true,
      }),
    ).toBe(false);
  });
});
