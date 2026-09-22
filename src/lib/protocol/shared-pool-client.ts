import type { LucidEvolution, Script, UTxO } from "@lucid-evolution/lucid";
import { marketplaceDeployment, marketplaceOrderbookAddress, marketplacePoolAddress } from "./marketplace-deployment";
import { addressData, asAsset, asConstr, assetUnit, type Tools } from "./dex-client";

export async function marketplaceScript(tools: Tools, name: string, parameterAddress: string): Promise<Script> {
  const response = await fetch(`/api/marketplace-blueprint?validator=${encodeURIComponent(name)}`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || typeof body.compiledCode !== "string") throw new Error(body.error || "Marketplace validator unavailable.");
  return { type: "PlutusV3", script: tools.applyParamsToScript(body.compiledCode, [addressData(tools, parameterAddress)]) };
}

export async function readSharedPool(lucid: LucidEvolution, tools: Tools) {
  const script = await marketplaceScript(tools, "quote_pool.quote_pool.spend", marketplaceOrderbookAddress);
  if (tools.validatorToAddress("Preprod", script) !== marketplacePoolAddress) throw new Error("Shared-pool address does not match the reviewed validator.");
  const utxo: UTxO = await lucid.utxoByUnit(marketplaceDeployment.pool.token);
  if (utxo.address !== marketplacePoolAddress || !utxo.datum || utxo.assets[marketplaceDeployment.pool.token] !== BigInt(1)) throw new Error("Shared-pool identity is invalid.");
  const raw = asConstr(tools.Data.from(utxo.datum), "shared pool");
  if (raw.index !== 0 || raw.fields.length !== 10 || typeof raw.fields[0] !== "string" || typeof raw.fields[1] !== "string" || ![6, 7, 9].every((i) => typeof raw.fields[i] === "bigint")) throw new Error("Malformed shared-pool state.");
  if (assetUnit(asAsset(raw.fields[2], "pool token")) !== marketplaceDeployment.pool.token) throw new Error("Shared-pool token does not match its datum.");
  const flag = asConstr(raw.fields[8], "pause flag");
  if (flag.fields.length !== 0 || ![0, 1].includes(flag.index)) throw new Error("Invalid pool pause flag.");
  const quote = asAsset(raw.fields[5], "quote asset");
  return { utxo, script, raw, admin: raw.fields[0], batcher: raw.fields[1], paused: flag.index === 1, quote, cash: utxo.assets[assetUnit(quote)] ?? BigInt(0), minimum: raw.fields[7] as bigint, inventory: raw.fields[9] as bigint, supply: raw.fields[6] as bigint, lpUnit: assetUnit(asAsset(raw.fields[3], "LP token")) };
}
