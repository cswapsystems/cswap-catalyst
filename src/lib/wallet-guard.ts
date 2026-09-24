// Shared pre-build/pre-sign session assertion (review finding R07).
// The wallet context stores the address captured at connection time; a CIP-30
// handle can later report a different account. Every transaction workbench must
// confirm the live signing account and network still match before building and
// again immediately before requesting a signature.
export const WALLET_CHANGED_MESSAGE = "Wallet account/network changed. Reconnect and review the transaction.";

export class WalletChangedError extends Error {
  constructor() { super(WALLET_CHANGED_MESSAGE); this.name = "WalletChangedError"; }
}

type GuardedLucid = { wallet(): { address(): Promise<string> }; config(): { network?: string } };

export async function assertWalletSession(lucid: GuardedLucid, expectedAddress: string | null | undefined): Promise<void> {
  if (!expectedAddress) throw new WalletChangedError();
  let live: string;
  try { live = await lucid.wallet().address(); }
  catch { throw new WalletChangedError(); }
  if (live !== expectedAddress || lucid.config().network !== "Preprod") throw new WalletChangedError();
}

export function isWalletChangedError(error: unknown): error is WalletChangedError {
  return error instanceof WalletChangedError;
}
