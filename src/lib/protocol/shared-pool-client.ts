import type { LucidEvolution, Script } from "@lucid-evolution/lucid";
import { marketplaceDeployment, marketplaceOrderbookAddress, marketplacePoolAddress } from "./marketplace-deployment";
import { addressData, type Tools } from "./dex-client";
import { decodeSharedPool, marketAssetData, marketUnit, outputRef, type MarketScripts } from "../marketplace";

export async function marketplaceCode(name: string): Promise<string> {
  const response = await fetch("/api/marketplace-blueprint?validator=" + encodeURIComponent(name), { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || typeof body.compiledCode !== "string") throw new Error(body.error || "Marketplace validator unavailable.");
  return body.compiledCode;
}
export async function marketplaceScript(tools: Tools, name: string, parameterAddress: string): Promise<Script> {
  return { type: "PlutusV3", script: tools.applyParamsToScript(await marketplaceCode(name), [addressData(tools, parameterAddress)]) };
}
export async function reviewedOrderbook(tools: Tools) {
  const script: Script = { type: "PlutusV3", script: await marketplaceCode("p2p_listing_simple.p2p_listing_simple.spend") };
  if (tools.validatorToAddress("Preprod", script) !== marketplaceOrderbookAddress) throw new Error("Marketplace deployment is schema-incompatible. The configured orderbook does not match the updated blueprint. Signing is disabled until a reviewed deployment/migration is configured.");
  return script;
}
export async function readSharedPool(lucid: LucidEvolution, tools: Tools) {
  const orderbook = await reviewedOrderbook(tools);
  const script = await marketplaceScript(tools, "quote_pool.quote_pool.spend", marketplaceOrderbookAddress);
  if (tools.validatorToAddress("Preprod", script) !== marketplacePoolAddress) throw new Error("Shared-pool deployment does not match the updated blueprint. Migration / fresh deployment is required before signing.");
  const utxo = await lucid.utxoByUnit(marketplaceDeployment.pool.token);
  if (!utxo || utxo.address !== marketplacePoolAddress) throw new Error("Shared-pool identity is not at its configured address.");
  const pool = decodeSharedPool(tools, utxo);
  if (marketUnit(pool.poolToken) !== marketplaceDeployment.pool.token || pool.lpUnit !== marketplaceDeployment.pool.lpToken || marketUnit(pool.inventoryToken) !== marketplaceDeployment.pool.inventoryToken) throw new Error("Shared-pool identities differ from the deployment manifest.");
  const [lpCode, inventoryCode] = await Promise.all([marketplaceCode("lp_policy.lp_policy.mint"), marketplaceCode("inventory_policy.inventory_policy.mint")]);
  const lp: Script = { type: "PlutusV3", script: tools.applyParamsToScript(lpCode, [marketAssetData(tools, pool.poolToken), pool.lpToken.assetName]) };
  const inventory: Script = { type: "PlutusV3", script: tools.applyParamsToScript(inventoryCode, [marketAssetData(tools, pool.poolToken), pool.inventoryToken.assetName, pool.batcher]) };
  if (tools.mintingPolicyToId(lp) !== pool.lpToken.policyId || tools.mintingPolicyToId(inventory) !== pool.inventoryToken.policyId) throw new Error("Pool LP / inventory policies do not match the reviewed blueprint.");
  // No burn-capable identity artifact is supplied by the contracts handover.
  // Never pretend one_shot can burn. Final exit remains gated until one is reviewed.
  const scripts: MarketScripts = { orderbook, pool: script, lp, inventory, orderbookAddress: marketplaceOrderbookAddress, poolAddress: marketplacePoolAddress };
  const refs = (marketplaceDeployment as unknown as { referenceScripts?: { txHash: string; outputIndex: number }[] }).referenceScripts || [];
  if (refs.length !== 4) throw new Error("All four Marketplace reference scripts must be configured before signing.");
  const outputs = await lucid.utxosByOutRef(refs);
  const hashes = outputs.map(output => output.scriptRef && tools.validatorToScriptHash(output.scriptRef));
  if (outputs.length !== 4 || [orderbook, script, lp, inventory].some(expected => !hashes.includes(tools.validatorToScriptHash(expected)))) throw new Error("Configured Marketplace reference scripts are missing or incompatible.");
  scripts.references = outputs;
  return { ...pool, script, scripts };
}
export async function assertMarketWallet(lucid: LucidEvolution, address: string) {
  if (await lucid.wallet().address() !== address || lucid.config().network !== "Preprod") throw new Error("Wallet account/network changed. Reconnect and review the transaction.");
}
export async function assertFreshPool(lucid: LucidEvolution, tools: Tools, expected: { utxo: import("@lucid-evolution/lucid").UTxO }) {
  const current = await readSharedPool(lucid, tools);
  if (outputRef(current.utxo) !== outputRef(expected.utxo)) throw new Error("Pool state or posted prices changed. Refresh and review before signing.");
  return current;
}
