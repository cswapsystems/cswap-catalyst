type Identity = { networkId: number; paymentCredential?: { type: string; hash: string } };

// UI eligibility only. APIs and validators must still verify the actual signer.
export function isOperatorIdentity(identity: Identity, allowedKeys: readonly string[]) {
  const key = identity.paymentCredential;
  return identity.networkId === 0 && key?.type === "Key" && /^[0-9a-f]{56}$/.test(key.hash)
    && allowedKeys.some(allowed => /^[0-9a-f]{56}$/.test(allowed) && allowed === key.hash);
}
