import type { LucidEvolution } from "@lucid-evolution/lucid";
import { asAsset, asConstr, assetUnit, type Tools } from "./dex-client";
import { marketplaceDeployment, marketplaceOrderbookAddress } from "./marketplace-deployment";

export async function readInventory(lucid: LucidEvolution, tools: Tools) {
  const holdings: Record<string, bigint> = {};
  const listings: { id: string; unit: string; quantity: bigint; ask: bigint }[] = [];
  for (const utxo of await lucid.utxosAt(marketplaceOrderbookAddress)) {
    if (!utxo.assets[marketplaceDeployment.pool.inventoryToken]) continue;
    if (!utxo.datum) throw new Error("Pool inventory cannot be verified: a receipt output has no datum.");
    const root = asConstr(tools.Data.from(utxo.datum), "pool inventory");
    const settlement = asConstr(root.fields[2], "pool settlement");
    if (root.index !== 0 || root.fields.length !== 7 || settlement.index !== 1 || assetUnit(asAsset(settlement.fields[0], "pool identity")) !== marketplaceDeployment.pool.token || assetUnit(asAsset(settlement.fields[1], "inventory receipt")) !== marketplaceDeployment.pool.inventoryToken || typeof root.fields[4] !== "bigint" || root.fields[4] <= BigInt(0) || typeof root.fields[6] !== "bigint") throw new Error("Pool inventory has an unreadable receipt. Reconcile before accepting more assets.");
    const unit = assetUnit(asAsset(root.fields[3], "inventory asset"));
    if ((utxo.assets[unit] || BigInt(0)) < root.fields[4]) throw new Error("Pool inventory quantity does not match its datum.");
    holdings[unit] = (holdings[unit] || BigInt(0)) + root.fields[4];
    listings.push({ id: `${utxo.txHash}#${utxo.outputIndex}`, unit, quantity: root.fields[4], ask: root.fields[6] });
  }
  return { holdings, listings };
}
