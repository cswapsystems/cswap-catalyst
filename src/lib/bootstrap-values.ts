type Tools = typeof import("@lucid-evolution/lucid");
type Output = Pick<import("@lucid-evolution/lucid").UTxO, "address" | "datum" | "assets"> & { label: string };

// Immutable escrow/pool datums encode the exact lovelace value. Do not let
// the transaction builder silently increase it to satisfy the ledger minimum.
export function assertBootstrapMinimumAda(tools: Tools, coinsPerUtxoByte: bigint, outputs: Output[]) {
  for (const output of outputs) {
    const minimum = tools.calculateMinLovelaceFromUTxO(coinsPerUtxoByte, { ...output, txHash: "00".repeat(32), outputIndex: 0 });
    if ((output.assets.lovelace ?? BigInt(0)) < minimum) throw new Error(`${output.label} requires at least ${minimum} lovelace. Increase the ADA buffer (or final ADA reserve) before locking these exact terms.`);
  }
}
