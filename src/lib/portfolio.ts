import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { addressData, asAsset, asConstr, assetUnit, decodePool, isAuthenticatedPool, displayName, loadDex, type Tools } from "./protocol/dex-client";
import { decodeMarketListing, marketUnit } from "./marketplace";
import { readLegacyRequests } from "./protocol/legacy-requests";
import { reviewedOrderbook, readSharedPool } from "./protocol/shared-pool-client";
import { scanOutputs } from "./safe-scan";
import { formatAda } from "./ada";

export type Position = { id: string; kind: "Vault" | "Listing" | "Instant Sell" | "Bootstrap" | "Bootstrap funding" | "DEX liquidity" | "Shared reserves"; unit: string; quantity: bigint; detail: string; deposit?: bigint; href: string; action: string };
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
    { name: "Marketplace escrow", read: async () => {
      const script = await reviewedOrderbook(tools);
      const result = scanOutputs(await lucid.utxosAt(tools.validatorToAddress("Preprod", script)), (utxo): Position | null => {
        if (!utxo.datum) return null;
        const listing = decodeMarketListing(tools, utxo);
        if (listing.sellerKey !== key.hash || listing.settlement.kind === "pool") return null;
        const instant = listing.settlement.kind === "instant";
        return { id: listing.id, kind: instant ? "Instant Sell" : "Listing", unit: marketUnit(listing.rwa), quantity: listing.quantity, deposit: listing.lockedLovelace, detail: (instant ? "Awaiting operator acceptance. Minimum payout: " : "Asking ") + quoteText(marketUnit(listing.priceAsset), listing.price) + ". You can edit or cancel before settlement.", href: "/portfolio/orders", action: "Manage listing" };
      });
      if (result.skipped) warnings["Marketplace escrow"] = `${result.skipped} unreadable outputs skipped.`;
      return result.items;
    } },
    { name: "Legacy Instant Sell recovery", read: async () => {
      const result = await readLegacyRequests(lucid, tools, owner);
      if (result.skipped) warnings["Legacy Instant Sell recovery"] = `${result.skipped} unreadable outputs skipped.`;
      return result.requests.map((request): Position => ({ id: request.id, kind: "Instant Sell", unit: request.unit, quantity: request.quantity, deposit: request.utxo.assets.lovelace ?? BigInt(0), detail: "Legacy request: cancellation only. New Instant Sell orders use the marketplace.", href: "/portfolio/orders", action: "Recover request" }));
    } },
    { name: "Bootstrap commitments", read: async () => {
      const { deployment, canCreatePool } = await dexContext;
      if (!canCreatePool || !deployment.bootstrapOfferAddress) throw new Error("Bootstrap requires the reviewed factory migration; no completeness claim is made for legacy offers.");
      const result = scanOutputs(await lucid.utxosAt(deployment.bootstrapOfferAddress), (utxo): Position | null => {
        if (!utxo.datum) return null;
        const escrow = asConstr(tools.Data.from(utxo.datum), "bootstrap escrow");
        if (![0, 1].includes(escrow.index) || escrow.fields.length !== (escrow.index === 0 ? 1 : 3)) return null;
        const fields = asConstr(escrow.fields[0], "bootstrap offer").fields;
        if (fields.length !== 9 || typeof fields[4] !== "bigint" || typeof fields[6] !== "bigint" || typeof fields[7] !== "bigint" || typeof fields[8] !== "bigint" || assetUnit(asAsset(fields[2], "factory")) !== deployment.factoryToken) return null;
        const unit = assetUnit(asAsset(fields[3], "fraction"));
        if ((utxo.assets[unit] ?? BigInt(0)) < fields[4]) return null;
        const funded = escrow.index === 1;
        const owner = fields[1] === key.hash;
        const provider = funded && escrow.fields[2] === key.hash && !owner;
        if (!owner && !provider) return null;
        const quoteUnit = assetUnit(asAsset(fields[5], "quote"));
        const providerAda = quoteUnit === "lovelace" ? fields[6] - fields[7] : BigInt(0);
        if (providerAda < BigInt(0)) return null;
        return { id: reference(utxo), kind: provider ? "Bootstrap funding" : "Bootstrap", unit, quantity: fields[4], deposit: owner ? funded && quoteUnit === "lovelace" ? fields[6] : fields[7] : providerAda, detail: provider ? `Your ${quoteText(quoteUnit, quoteUnit === "lovelace" ? providerAda : fields[6])} quote deposit is locked with these FT units until Team pool creation. Your LP allocation is ${100 - Number(fields[8]) / 100}%.` : `${funded ? "Funded escrow awaiting Team pool creation" : fields[8] === BigInt(10_000) ? "Open offer awaiting your quote deposit" : "Open offer awaiting an LP"}. Quote reserve: ${quoteText(quoteUnit, fields[6])}. Your initial LP share: ${Number(fields[8]) / 100}%. ${funded ? "You cannot cancel after funding." : "You can cancel before funding."}`, href: "/dex/launch", action: funded ? "View funded escrow" : "Manage offer" };
      });
      if (result.skipped) warnings["Bootstrap commitments"] = `${result.skipped} unreadable outputs skipped.`;
      return result.items;
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
      if (pool.closing?.key === key.hash) return [{ id: reference(pool.utxo), kind: "Shared reserves", unit: pool.lpUnit, quantity: BigInt(0), detail: `Final LP exit in progress. ${pool.count} inventory listings remain to return before completion.`, href: "/portfolio/reserves", action: "Continue exit" }];
      if (held <= BigInt(0) || pool.supply <= BigInt(0)) return [];
      const available = pool.cash > pool.minimum ? pool.cash - pool.minimum : BigInt(0);
      return [{ id: reference(pool.utxo), kind: "Shared reserves", unit: pool.lpUnit, quantity: held, detail: `Estimated withdrawal above protected reserve: ${quoteText(assetUnit(pool.quote), held * available / pool.supply)}. Partial withdrawals remain available with open inventory and while paused, but surrender the burned shares’ inventory exposure. Inventory cost basis: ${quoteText(assetUnit(pool.quote), pool.cost)}; resale asks are not cash. Final exit requires a burn-capable pool identity deployment.`, href: "/portfolio/reserves", action: "Manage reserves" }];
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
