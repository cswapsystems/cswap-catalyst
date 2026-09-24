import type { LucidEvolution } from "@lucid-evolution/lucid";
import { decodeMarketListing, marketUnit, type SharedPool, type MarketListing } from "../marketplace";
import { type Tools } from "./dex-client";
import { marketplaceDeployment, marketplaceOrderbookAddress } from "./marketplace-deployment";
import { reviewedOrderbook } from "./shared-pool-client";

export async function readInventory(lucid: LucidEvolution, tools: Tools, pool?: SharedPool) {
  await reviewedOrderbook(tools);
  const holdings: Record<string, bigint> = {};
  const listings: (MarketListing & { unit: string; ask: bigint })[] = [];
  for (const utxo of await lucid.utxosAt(marketplaceOrderbookAddress)) {
    if (!utxo.assets[marketplaceDeployment.pool.inventoryToken]) continue;
    const listing = decodeMarketListing(tools, utxo), s = listing.settlement;
    if (s.kind !== "pool" || marketUnit(s.poolToken) !== marketplaceDeployment.pool.token || marketUnit(s.inventoryToken) !== marketplaceDeployment.pool.inventoryToken) throw new Error("Unreconciled pool inventory receipt.");
    if (pool && (listing.seller !== pool.utxo.address || listing.sellerKey !== pool.batcher || marketUnit(listing.priceAsset) !== marketUnit(pool.quote))) throw new Error("Pool inventory binding mismatch.");
    const unit = marketUnit(listing.rwa);
    holdings[unit] = (holdings[unit] || BigInt(0)) + listing.quantity;
    listings.push({ ...listing, unit, ask: listing.price });
  }
  if (pool && (BigInt(listings.length) !== pool.count || listings.reduce((sum, listing) => sum + (listing.settlement.kind === "pool" ? listing.settlement.cost : BigInt(0)), BigInt(0)) !== pool.cost || listings.reduce((sum, listing) => sum + listing.ask, BigInt(0)) !== pool.inventory)) throw new Error("Inventory totals do not match the pool snapshot. Refresh before signing.");
  return { holdings, listings };
}
