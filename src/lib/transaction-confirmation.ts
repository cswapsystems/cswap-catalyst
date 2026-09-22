import type { LucidEvolution } from "@lucid-evolution/lucid";

export async function confirmTransaction(wallet: Pick<LucidEvolution, "awaitTxConfirmation">, hash: string) {
  try {
    return await wallet.awaitTxConfirmation(hash, { timeout: 60_000, checkInterval: 3_000 });
  } catch {
    throw new Error(`Transaction submitted (${hash}), but confirmation could not be verified within this check. Use Check confirmation or the explorer before retrying. This does not mean the transaction failed.`);
  }
}
