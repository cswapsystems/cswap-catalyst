export type Tools = typeof import("@lucid-evolution/lucid");
export type AssetClass = { policyId: string; assetName: string };
export type Deployment = { network: "preprod"; admin: string; factoryToken: string; factoryAddress: string; ammAddress: string; lpPolicyId: string; poolPolicyId: string; bootstrapOfferAddress?: string; transaction: string };
export type Scripts = { factoryState?: import("@lucid-evolution/lucid").Script; amm: import("@lucid-evolution/lucid").Script; lp: import("@lucid-evolution/lucid").Script; poolFactory: import("@lucid-evolution/lucid").Script };
export type Pool = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; raw: import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data>; poolNft: AssetClass; assetA: AssetClass; assetB: AssetClass; lpToken: AssetClass; feeN: bigint; feeD: bigint; reserveA: bigint; reserveB: bigint; liquidity: bigint; poolLovelace: bigint };
export type Action = "create" | "swap-a" | "swap-b" | "add" | "remove" | "destroy";

export const actions: { id: Action; label: string }[] = [
  { id: "swap-a", label: "Buy fractions" }, { id: "swap-b", label: "Sell fractions" },
  { id: "add", label: "Add liquidity" }, { id: "remove", label: "Remove liquidity" },
  { id: "create", label: "Create pool" }, { id: "destroy", label: "Destroy pool" },
];

export function assetData(tools: Tools, asset: AssetClass) { return new tools.Constr(0, [asset.policyId, asset.assetName]); }
export function assetUnit(asset: AssetClass) { return asset.policyId ? asset.policyId + asset.assetName : "lovelace"; }
export function parseUnit(value: string): AssetClass {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length < 56 || normalized.length % 2 !== 0) throw new Error("The fraction asset unit must be policy ID + asset name in hexadecimal.");
  return { policyId: normalized.slice(0, 56), assetName: normalized.slice(56) };
}
export function parseIntegerAmount(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) throw new Error(label + " must be a positive whole number of base units.");
  return BigInt(normalized);
}
export function addressData(tools: Tools, address: string) {
  const details = tools.getAddressDetails(address);
  if (!details.paymentCredential) throw new Error("Address has no payment credential.");
  const credential = (item: { type: "Key" | "Script"; hash: string }) => item.type === "Key" ? { PubKeyCredential: [item.hash] } : { ScriptCredential: [item.hash] };
  return tools.Data.from(tools.Data.to({ addressCredential: credential(details.paymentCredential), addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null } as never, tools.AddressSchema as never));
}
export function poolName(id: bigint) { return id.toString(16).padStart(16, "0"); }
export function integerSqrt(value: bigint) { if (value < BigInt(0)) throw new Error("Negative square root."); if (value < BigInt(2)) return value; let x = value; let y = (x + BigInt(1)) / BigInt(2); while (y < x) { x = y; y = (x + value / x) / BigInt(2); } return x; }
export function gcd(a: bigint, b: bigint) { while (b !== BigInt(0)) { const next = a % b; a = b; b = next; } return a; }
export function asConstr(value: unknown, label: string): import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data> {
  if (!(value && typeof value === "object" && "index" in value && "fields" in value && Array.isArray((value as { fields: unknown }).fields))) throw new Error(`Malformed ${label} datum.`);
  return value as import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data>;
}
export function asAsset(value: unknown, label: string): AssetClass {
  const item = asConstr(value, label);
  if (item.fields.length !== 2 || typeof item.fields[0] !== "string" || typeof item.fields[1] !== "string") throw new Error(`Malformed ${label}.`);
  return { policyId: item.fields[0], assetName: item.fields[1] };
}
export function decodePool(tools: Tools, utxo: import("@lucid-evolution/lucid").UTxO): Pool {
  if (!utxo.datum) throw new Error("Pool datum is missing.");
  const raw = asConstr(tools.Data.from(utxo.datum), "pool");
  if (raw.fields.length !== 10 || !raw.fields.slice(4, 10).every((value) => typeof value === "bigint")) throw new Error("Malformed pool datum.");
  return { id: assetUnit(asAsset(raw.fields[0], "pool NFT")), utxo, raw, poolNft: asAsset(raw.fields[0], "pool NFT"), assetA: asAsset(raw.fields[1], "quote asset"), assetB: asAsset(raw.fields[2], "fraction asset"), lpToken: asAsset(raw.fields[3], "LP token"), feeN: raw.fields[4] as bigint, feeD: raw.fields[5] as bigint, reserveA: raw.fields[6] as bigint, reserveB: raw.fields[7] as bigint, liquidity: raw.fields[8] as bigint, poolLovelace: raw.fields[9] as bigint };
}

export function isAuthenticatedPool(pool: Pool, deployment: Deployment): boolean {
  return pool.utxo.address === deployment.ammAddress && pool.poolNft.policyId === deployment.poolPolicyId && pool.lpToken.policyId === deployment.lpPolicyId && pool.lpToken.assetName === pool.poolNft.assetName && pool.utxo.assets[assetUnit(pool.poolNft)] === BigInt(1) && pool.reserveA > BigInt(0) && pool.reserveB > BigInt(0) && pool.liquidity > BigInt(0) && pool.utxo.assets[assetUnit(pool.assetA)] === pool.reserveA && pool.utxo.assets[assetUnit(pool.assetB)] === pool.reserveB;
}
export function nextDatum(tools: Tools, pool: Pool, reserveA: bigint, reserveB: bigint, liquidity: bigint) {
  return new tools.Constr(0, [pool.raw.fields[0], pool.raw.fields[1], pool.raw.fields[2], pool.raw.fields[3], pool.feeN, pool.feeD, reserveA, reserveB, liquidity, pool.assetA.policyId ? pool.poolLovelace : reserveA]);
}
export function poolValue(pool: Pool, reserveA: bigint, reserveB: bigint) {
  return pool.assetA.policyId ? { lovelace: pool.poolLovelace, [assetUnit(pool.assetA)]: reserveA, [assetUnit(pool.assetB)]: reserveB, [assetUnit(pool.poolNft)]: BigInt(1) } : { lovelace: reserveA, [assetUnit(pool.assetB)]: reserveB, [assetUnit(pool.poolNft)]: BigInt(1) };
}
export function reservePayout(pool: Pool) {
  return pool.assetA.policyId ? { lovelace: pool.poolLovelace, [assetUnit(pool.assetA)]: pool.reserveA, [assetUnit(pool.assetB)]: pool.reserveB } : { lovelace: pool.reserveA, [assetUnit(pool.assetB)]: pool.reserveB };
}
export function displayName(asset: AssetClass) {
  if (!asset.policyId) return "tADA";
  try { const pairs = asset.assetName.match(/.{2}/g) ?? []; return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(pairs, (byte) => Number.parseInt(byte, 16))) || "Fraction token"; }
  catch { return "Fraction token"; }
}
export function dexLpDisplayName(assetA: AssetClass, assetB: AssetClass, label: (asset: AssetClass) => string) {
  return `${label(assetB)} - ${assetA.policyId ? label(assetA) : "ADA"} LP`;
}
export function formatPoolSpotPrice(quoteReserve: bigint, tokenReserve: bigint, adaQuote: boolean, precision = 6) {
  if (quoteReserve <= BigInt(0) || tokenReserve <= BigInt(0)) return "Unavailable";
  const denominator = tokenReserve * (adaQuote ? BigInt(1_000_000) : BigInt(1));
  const whole = quoteReserve / denominator;
  const remainder = quoteReserve % denominator;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!remainder || precision <= 0) return grouped;
  const scale = BigInt(10) ** BigInt(precision);
  const fraction = (remainder * scale / denominator).toString().padStart(precision, "0").replace(/0+$/, "");
  if (fraction) return `${grouped}.${fraction}`;
  return whole === BigInt(0) ? `< 0.${"0".repeat(Math.max(precision - 1, 0))}1` : grouped;
}
export function format(value: bigint) { return new Intl.NumberFormat("en-US").format(value); }

export async function loadDex(tools: Tools) {
  const response = await fetch("/api/dex-blueprint", { cache: "no-store" });
  const body = await response.json() as { validators?: Record<string, string>; deployment?: Deployment; error?: string };
  if (!response.ok || !body.validators || !body.deployment) throw new Error(body.error ?? "DEX deployment is unavailable.");
  const deployment = body.deployment;
  const factoryToken = parseUnit(deployment.factoryToken);
  const amm = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["amm_pool.amm_pool.spend"], [assetData(tools, factoryToken)]) };
  const lp = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["lp_policy.lp_policy.mint"], [assetData(tools, factoryToken), addressData(tools, deployment.ammAddress)]) };
  const poolFactory = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["pool_factory.pool_factory.mint"], [assetData(tools, factoryToken), addressData(tools, deployment.ammAddress), deployment.lpPolicyId]) };
  if (tools.validatorToAddress("Preprod", amm) !== deployment.ammAddress || tools.mintingPolicyToId(lp) !== deployment.lpPolicyId || tools.mintingPolicyToId(poolFactory) !== deployment.poolPolicyId) throw new Error("The AMM deployment record does not match the current DEX contracts.");
  const offerCode = body.validators["bootstrap_offer.bootstrap_offer.spend"];
  const factoryCode = body.validators["factory_state.factory_state.spend"];
  let factoryState: import("@lucid-evolution/lucid").Script | undefined;
  if (offerCode && factoryCode) {
    const offer = { type: "PlutusV3" as const, script: offerCode };
    const offerAddress = tools.validatorToAddress("Preprod", offer);
    const candidate = { type: "PlutusV3" as const, script: tools.applyParamsToScript(factoryCode, [deployment.admin, addressData(tools, offerAddress) as import("@lucid-evolution/lucid").Data]) };
    if (deployment.bootstrapOfferAddress === offerAddress && tools.validatorToAddress("Preprod", candidate) === deployment.factoryAddress) factoryState = candidate;
  }
  return { deployment, scripts: { factoryState, amm, lp, poolFactory } satisfies Scripts, canCreatePool: Boolean(factoryState) };
}
