import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { addressData, asAsset, asConstr, assetUnit, decodePool, isAuthenticatedPool, displayName, loadDex, type Tools } from "./protocol/dex-client";
import { marketplaceOrderbookAddress, marketplacePoolAddress, marketplaceDeployment } from "./protocol/marketplace-deployment";
import { marketplaceScript, readSharedPool } from "./protocol/shared-pool-client";
import { scanOutputs } from "./safe-scan";
import { formatAda } from "./ada";

export type Position = { id: string; kind: "Vault" | "Listing" | "Instant Sell" | "Bootstrap" | "DEX liquidity" | "Shared reserves"; unit: string; quantity: bigint; detail: string; deposit?: bigint; href: string; action: string };
export type PositionGroup = { name: string; positions: Position[]; error?: string; warning?: string };
const reference = (utxo: UTxO) => `${utxo.txHash}#${utxo.outputIndex}`;
const quoteText = (unit: string, amount: bigint) => unit === "lovelace" ? formatAda(amount) + " ADA" : amount.toString() + " base units of " + unit;

export async function loadPortfolio(lucid: LucidEvolution, owner: string): Promise<PositionGroup[]> {
  const tools = await import("@lucid-evolution/lucid");
  if (await lucid.wallet().address() !== owner) throw new Error("Wallet account changed. Reconnect before loading positions.");
  const key = tools.getAddressDetails(owner).paymentCredential;
  if (key?.type !== "Key") throw new Error("A payment-key wallet is required.");
  const holdings: Record<string, bigint> = {};
  for (const utxo of await lucid.wallet().getUtxos()) for (const [unit, amount] of Object.entries(utxo.assets)) holdings[unit] = (holdings[unit] ?? BigInt(0)) + amount;
  const ownAddress = tools.Data.to(addressData(tools, owner));
  const dexContext = loadDex(tools);
  const warnings: Record<string, string> = {};
  const scan = (name: string, ...args: Parameters<typeof decodePositions>) => {
    const result = decodePositions(...args);
    if (result.skipped) warnings[name] = `${result.skipped} unreadable outputs were skipped; valid positions are shown.`;
    return result.items;
  };

  const sources: { name: string; read: () => Promise<Position[]> }[] = [
    { name: "Vaults", read: async () => {
      const response = await fetch("/api/fractionalize-blueprint", { cache: "no-store" });
      const blueprint = await response.json();
      if (!response.ok || !blueprint.vaultCompiledCode) throw new Error("Vault deployment unavailable.");
      const address = tools.validatorToAddress("Preprod", { type: "PlutusV3", script: blueprint.vaultCompiledCode });
      return scan("Vaults", await lucid.utxosAt(address), tools, (utxo, fields) => {
        if (fields.length !== 8 || typeof fields[6] !== "bigint" || typeof fields[2] !== "string" || typeof fields[3] !== "string" || typeof fields[4] !== "string" || typeof fields[5] !== "string") return null;
        const unit = fields[2] + fields[3], fraction = fields[4] + fields[5];
        if (utxo.assets[unit] !== BigInt(1)) return null;
        const held = holdings[fraction] ?? BigInt(0);
        const originalOwner = tools.Data.to(fields[0]) === ownAddress;
        if (!originalOwner && held === BigInt(0)) return null;
        return { id: reference(utxo), kind: "Vault", unit, quantity: BigInt(1), detail: `${held} of ${fields[6]} fractions in wallet. ${originalOwner ? "You are the recorded original owner. " : ""}The NFT is held by the vault; full-supply burn is required to combine.`, href: "/fractionalize?mode=combine&asset=" + unit, action: "Manage fractions" };
      });
    } },
    { name: "Marketplace escrow", read: async () => scan("Marketplace escrow", await lucid.utxosAt(marketplaceOrderbookAddress), tools, (utxo, fields) => {
      if (fields.length !== 7 || fields[1] !== key.hash || typeof fields[4] !== "bigint" || typeof fields[6] !== "bigint" || asConstr(fields[2], "settlement").index !== 0) return null;
      const unit = assetUnit(asAsset(fields[3], "listed asset"));
      if ((utxo.assets[unit] ?? BigInt(0)) < fields[4]) return null;
      return { id: reference(utxo), kind: "Listing", unit, quantity: fields[4], deposit: utxo.assets.lovelace ?? BigInt(0), detail: "Asking " + quoteText(assetUnit(asAsset(fields[5], "payment")), fields[6]) + ". Deposit returns according to listing settlement terms.", href: "/portfolio/orders", action: "Manage listing" };
    }) },
    { name: "Instant Sell requests", read: async () => {
      const script = await marketplaceScript(tools, "pool_sell_request.pool_sell_request.spend", marketplacePoolAddress);
      return scan("Instant Sell requests", await lucid.utxosAt(tools.validatorToAddress("Preprod", script)), tools, (utxo, fields) => {
        if (fields.length !== 7 || fields[1] !== key.hash || typeof fields[4] !== "bigint" || typeof fields[6] !== "bigint" || assetUnit(asAsset(fields[2], "pool identity")) !== marketplaceDeployment.pool.token) return null;
        const unit = assetUnit(asAsset(fields[3], "requested asset"));
        if ((utxo.assets[unit] ?? BigInt(0)) < fields[4]) return null;
        return { id: reference(utxo), kind: "Instant Sell", unit, quantity: fields[4], deposit: utxo.assets.lovelace ?? BigInt(0), detail: "Awaiting batcher acceptance. Minimum payout: " + quoteText(assetUnit(asAsset(fields[5], "quote")), fields[6]) + ". You can cancel before acceptance.", href: "/portfolio/orders", action: "Manage request" };
      });
    } },
    { name: "Bootstrap commitments", read: async () => {
      const { deployment, canCreatePool } = await dexContext;
      if (!canCreatePool || !deployment.bootstrapOfferAddress) throw new Error("Bootstrap requires the reviewed factory migration; no completeness claim is made for legacy offers.");
      return scan("Bootstrap commitments", await lucid.utxosAt(deployment.bootstrapOfferAddress), tools, (utxo, fields) => {
        if (fields.length !== 9 || fields[1] !== key.hash || typeof fields[4] !== "bigint" || typeof fields[6] !== "bigint" || typeof fields[8] !== "bigint" || assetUnit(asAsset(fields[2], "factory")) !== deployment.factoryToken) return null;
        const unit = assetUnit(asAsset(fields[3], "fraction"));
        if ((utxo.assets[unit] ?? BigInt(0)) < fields[4]) return null;
        return { id: reference(utxo), kind: "Bootstrap", unit, quantity: fields[4], deposit: utxo.assets.lovelace ?? BigInt(0), detail: `Awaiting LP and Team signatures. Quote reserve: ${quoteText(assetUnit(asAsset(fields[5], "quote")), fields[6])}. Your initial LP share: ${Number(fields[8]) / 100}%. ADA is committed to the pool on acceptance, or refunded on cancellation.`, href: "/dex/launch", action: "Manage offer" };
      });
    } },
    { name: "DEX liquidity", read: async () => {
      const { deployment } = await dexContext;
      const positions: Position[] = [];
      const scanned = scanOutputs(await lucid.utxosAt(deployment.ammAddress), (utxo) => utxo.datum ? decodePool(tools, utxo) : null);
      if (scanned.skipped) warnings["DEX liquidity"] = `${scanned.skipped} unreadable outputs were skipped.`;
      for (const pool of scanned.items) {
        const utxo = pool.utxo;
        if (!isAuthenticatedPool(pool, deployment)) continue;
        const unit = assetUnit(pool.lpToken), held = holdings[unit] ?? BigInt(0);
        if (held <= BigInt(0) || pool.liquidity <= BigInt(0)) continue;
        positions.push({ id: reference(utxo), kind: "DEX liquidity", unit, quantity: held, detail: `Pool: ${displayName(pool.assetB)} / ${displayName(pool.assetA)}. Proportional reserves: ${quoteText(assetUnit(pool.assetA), held * pool.reserveA / pool.liquidity)} + ${quoteText(assetUnit(pool.assetB), held * pool.reserveB / pool.liquidity)}. Withdrawal availability depends on factory state; full supply requires administrator closure.`, href: "/dex/liquidity?pool=" + pool.id, action: "Manage liquidity" });
      }
      return positions;
    } },
    { name: "Shared reserves", read: async () => {
      const pool = await readSharedPool(lucid, tools), held = holdings[pool.lpUnit] ?? BigInt(0);
      if (held <= BigInt(0) || pool.supply <= BigInt(0)) return [];
      const available = pool.cash > pool.minimum ? pool.cash - pool.minimum : BigInt(0);
      return [{ id: reference(pool.utxo), kind: "Shared reserves", unit: pool.lpUnit, quantity: held, detail: `Estimated withdrawal above protected reserve: ${quoteText(assetUnit(pool.quote), held * available / pool.supply)}. ${pool.inventory > BigInt(0) ? "Withdrawals blocked while inventory is open." : pool.paused ? "Pool paused." : "Subject to fresh state and transaction fees."} Inventory ask value is not cash.`, href: "/portfolio/reserves", action: "Manage reserves" }];
    } },
  ];
  const results = await Promise.allSettled(sources.map((source) => source.read()));
  if (await lucid.wallet().address() !== owner) throw new Error("Wallet account changed while loading. Reconnect and refresh.");
  return results.map((result, index) => result.status === "fulfilled" ? { name: sources[index].name, positions: result.value, warning: warnings[sources[index].name] } : { name: sources[index].name, positions: [], error: result.reason instanceof Error ? result.reason.message : "Unable to read this source." });
}

function decodePositions(utxos: UTxO[], tools: Tools, decode: (utxo: UTxO, fields: import("@lucid-evolution/lucid").Data[]) => Position | null) {
  return scanOutputs(utxos, (utxo) => {
    if (!utxo.datum) return null;
    const root = asConstr(tools.Data.from(utxo.datum), "position");
    return root.index === 0 ? decode(utxo, root.fields) : null;
  });
}
