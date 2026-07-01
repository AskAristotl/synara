// FILE: wsOriginPolicy.ts
// Purpose: Pure decision for whether the /ws upgrade route must enforce its
//          origin (CSRF) gate. Only a VALIDATED credential may bypass the
//          gate; token presence alone is spoofable by any cross-origin page.
// Layer: Server utility (pure predicate, no Effect/IO)

export function shouldRejectWsUpgrade(input: {
  readonly legacyAuthorized: boolean;
  readonly wsTokenValidated: boolean;
  readonly originUntrusted: boolean;
}): boolean {
  return !input.legacyAuthorized && !input.wsTokenValidated && input.originUntrusted;
}
