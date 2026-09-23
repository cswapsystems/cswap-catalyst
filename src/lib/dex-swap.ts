import type { AssetClass } from "./protocol/dex-client";

type Market = { id: string; assetA: AssetClass; assetB: AssetClass };
const unit = (asset: AssetClass) => asset.policyId ? asset.policyId + asset.assetName : "lovelace";

export function swapTokens(markets: Market[]): AssetClass[] {
  return [...new Map(markets.flatMap((market) => [market.assetA, market.assetB]).map((asset) => [unit(asset), asset])).values()];
}

export function swapTargets(markets: Market[], from: string): AssetClass[] {
  const targets = markets.flatMap((market) => unit(market.assetA) === from ? [market.assetB] : unit(market.assetB) === from ? [market.assetA] : []);
  return [...new Map(targets.filter((asset) => unit(asset) !== from).map((asset) => [unit(asset), asset])).values()];
}

// Token selectors only offer real, direct pools. Preserve the selected pool
// where possible instead of switching between duplicate pairs on a refresh.
export function findSwapMarket(markets: Market[], from: string, to?: string, preferredId?: string) {
  const candidates = preferredId ? [...markets.filter((market) => market.id === preferredId), ...markets.filter((market) => market.id !== preferredId)] : markets;
  for (const market of candidates) {
    if (unit(market.assetA) === from && unit(market.assetB) !== from && (!to || unit(market.assetB) === to)) return { id: market.id, action: "swap-a" as const };
    if (unit(market.assetB) === from && unit(market.assetA) !== from && (!to || unit(market.assetA) === to)) return { id: market.id, action: "swap-b" as const };
  }
  return null;
}
