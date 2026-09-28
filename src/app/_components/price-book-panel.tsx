"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { readSharedPool, assertFreshPool } from "@/lib/protocol/shared-pool-client";
import { readInventory } from "@/lib/protocol/inventory";
import { buildMarketAction, marketUnit, type PoolPrice, type MarketListing } from "@/lib/marketplace";
import { readRegistry, type RegistryState } from "@/lib/asset-registry";
import { changedPriceUnits, displayQuoteAmount, eligibleRegistryUnits, makePoolPrice, parseQuoteAmount } from "@/lib/pool-price-editor";
import { walletAssetName } from "@/lib/wallet-assets";
import { useWallet } from "./wallet-context";
import { useMarketTransaction } from "./use-market-transaction";
import MarketTransactionStatus from "./market-transaction-status";

export default function PriceBookPanel() {
  const { lucid, address, connect } = useWallet();
  const [pool, setPool] = useState<Awaited<ReturnType<typeof readSharedPool>> | null>(null);
  const [registry, setRegistry] = useState<RegistryState | null>(null);
  const [registryError, setRegistryError] = useState("");
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof readInventory>> | null>(null);
  const [prices, setPrices] = useState<PoolPrice[]>([]);
  const [dirty, setDirty] = useState(false), [error, setError] = useState(""), [authorized, setAuthorized] = useState(false), [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ unit: "", buyAmount: "", buyQuantity: "1", sellAmount: "", sellQuantity: "1" });
  const [asks, setAsks] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    setPool(null); setRegistry(null); setRegistryError(""); setInventory(null); setPrices([]); setAuthorized(false); setError(""); setDirty(false);
    if (!lucid || !address) return; setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const current = await readSharedPool(lucid, tools); setPool(current); setPrices(current.prices);
      try { setRegistry(await readRegistry(lucid)); }
      catch (cause) { setRegistryError(cause instanceof Error ? cause.message : "Approved assets unavailable."); }
      const credential = tools.getAddressDetails(address).paymentCredential;
      setAuthorized(credential?.type === "Key" && credential.hash === current.batcher);
      setInventory(await readInventory(lucid, tools, current));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "On-chain prices unavailable."); }
    finally { setLoading(false); }
  }, [lucid, address]);
  useEffect(() => { void refresh(); }, [refresh]);
  const transaction = useMarketTransaction(refresh, "pool pricing or inventory update");
  const blocked = loading || transaction.busy || Boolean(transaction.hash);
  const adaQuote = !pool?.quote.policyId;
  const quoteLabel = adaQuote ? "tADA" : `${walletAssetName(pool?.quote.assetName ?? "")} base units`;
  const quoteAmount = (value: bigint) => `${displayQuoteAmount(value, adaQuote)} ${quoteLabel}`;
  function stage() {
    try {
      if (!pool || !registry) throw new Error("Read the pool and approved-asset registry before editing prices.");
      const unit = form.unit;
      if (!registry.entries.includes(unit) || unit === marketUnit(pool.quote)) throw new Error("Select an issuer-approved non-quote asset.");
      const entry = makePoolPrice(unit, form.buyAmount, form.buyQuantity, form.sellAmount, form.sellQuantity, adaQuote);
      const next = [...prices.filter((price) => marketUnit(price.asset) !== unit), entry];
      if (next.length > 50) throw new Error("The validator supports at most 50 exact asset prices.");
      setPrices(next); setDirty(true); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid price."); }
  }
  async function submit(listing?: MarketListing) {
    if (!lucid || !pool) return;
    const tools = await import("@lucid-evolution/lucid");
    await transaction.run(async () => {
      const current = await assertFreshPool(lucid, tools, pool);
      if (!listing) {
        const changed = changedPriceUnits(current.prices, prices);
        if (changed.length) {
          const latestRegistry = await readRegistry(lucid);
          if (changed.some((unit) => !latestRegistry.entries.includes(unit))) throw new Error("An edited asset is no longer issuer-approved. Refresh prices and registry before signing.");
        }
      }
      const reprice = listing ? parseQuoteAmount(asks[listing.id] || "", adaQuote) : null;
      if (listing && !(await lucid.utxosByOutRef([listing.utxo])).length) throw new Error("Listing was already spent. Refresh inventory.");
      return buildMarketAction(lucid, tools, current.scripts, address, listing && reprice !== null ? { kind: "reprice", listing, price: reprice } : { kind: "prices", prices }, current);
    }, () => assertFreshPool(lucid, tools, pool));
  }
  return <section className="work-card form-card price-book-panel">
    <div className="section-heading"><h2>On-chain prices & inventory</h2><button type="button" className="refresh-button" disabled={blocked || dirty} onClick={() => void refresh()}>Refresh pool</button></div>
    <p>Choose an issuer-approved asset, set what the pool pays sellers and what it asks buyers, then publish the draft on-chain. Removing a price stops new acquisitions; existing inventory keeps its own ask until repriced.</p>
    {!lucid && <button type="button" onClick={() => void connect()}>Connect wallet</button>}
    {error && <p role="alert">{error}</p>}
    {pool && <>
      <div className="price-quote-card"><div><span className="section-kicker">Settlement asset · fixed for this pool</span><strong>{adaQuote ? "tADA (Preprod ADA)" : walletAssetName(pool.quote.assetName)}</strong><code>{marketUnit(pool.quote)}</code></div><p>Every seller payout, inventory ask and reserve in this pool uses this quote asset. It is set when the pool is created and cannot be changed by editing a price. {adaQuote ? "Enter prices in ADA; the app converts them exactly to lovelace." : "Enter integer native-token base units; display decimals are not configured for this asset."}</p></div>
      {registryError && <p role="alert">Approved-asset registry unavailable: {registryError}. New price entries are disabled until it can be read.</p>}
      {pool.closing && <p role="status">Closing: price updates and new acquisitions disabled.</p>}
      {dirty && <p role="status">Draft only — these prices are not live until the on-chain update confirms. Live pool snapshot: <code>{pool.utxo.txHash}#{pool.utxo.outputIndex}</code>.</p>}
      <h3>Posted asset prices</h3>
      {prices.map((price) => {
        const unit = marketUnit(price.asset), approved = registry?.entries.includes(unit) ?? false;
        return <article className="position-card" key={unit}><div><strong>{walletAssetName(price.asset.assetName)}</strong><code>{unit}</code><p>Pool pays seller: <strong>{quoteAmount(price.buy.numerator)}</strong> for {price.buy.denominator.toString()} asset base units.</p><p>Pool asks buyer: <strong>{quoteAmount(price.sell.numerator)}</strong> for {price.sell.denominator.toString()} asset base units.</p><p>{registry ? approved ? "Issuer-approved asset" : "Not in the current registry; this existing price can be removed but not edited." : "Registry status unavailable."} Totals for other quantities round down to quote base units.</p></div><div className="marketplace-actions"><button type="button" disabled={blocked || !authorized || !approved || Boolean(pool.closing)} onClick={() => setForm({ unit, buyAmount: displayQuoteAmount(price.buy.numerator, adaQuote), buyQuantity: price.buy.denominator.toString(), sellAmount: displayQuoteAmount(price.sell.numerator, adaQuote), sellQuantity: price.sell.denominator.toString() })}>Edit draft</button><button type="button" disabled={blocked || !authorized || Boolean(pool.closing)} onClick={() => { setPrices(prices.filter((item) => item !== price)); setDirty(true); }}>Remove price from draft</button></div></article>;
      })}
      {!prices.length && <p>{dirty ? "The draft removes every price. Publish to stop all new acquisitions." : "No assets have a posted price. Missing a price prevents new acquisitions."}</p>}
      <fieldset className="module-fieldset" disabled={blocked || !authorized || Boolean(pool.closing)}>
        <div className="marketplace-form-grid">
          <label className="field field-wide"><span>Issuer-approved asset</span><select value={form.unit} disabled={!registry} onChange={(event) => setForm({ ...form, unit: event.target.value })}><option value="">Select an asset from the registry</option>{eligibleRegistryUnits(registry?.entries ?? [], marketUnit(pool.quote)).map((unit) => <option key={unit} value={unit}>{walletAssetName(unit.slice(56))} · {unit.slice(0, 12)}…{unit.slice(-8)}</option>)}</select></label>
          {form.unit && <p className="price-selected-unit field-wide">Exact asset ID: <code>{form.unit}</code></p>}
          <label className="field"><span>Pool pays seller · {quoteLabel}</span><input inputMode={adaQuote ? "decimal" : "numeric"} value={form.buyAmount} onChange={(event) => setForm({ ...form, buyAmount: event.target.value })} placeholder={adaQuote ? "e.g. 0.5" : "e.g. 500"} /></label>
          <label className="field"><span>For this many asset base units</span><input inputMode="numeric" value={form.buyQuantity} onChange={(event) => setForm({ ...form, buyQuantity: event.target.value })} /></label>
          <label className="field"><span>Pool asks buyer · {quoteLabel}</span><input inputMode={adaQuote ? "decimal" : "numeric"} value={form.sellAmount} onChange={(event) => setForm({ ...form, sellAmount: event.target.value })} placeholder={adaQuote ? "e.g. 0.75" : "e.g. 750"} /></label>
          <label className="field"><span>For this many asset base units</span><input inputMode="numeric" value={form.sellQuantity} onChange={(event) => setForm({ ...form, sellQuantity: event.target.value })} /></label>
        </div>
        <p className="price-ratio-note">Why quantities? The validator stores each price as exact quote base units divided by asset base units. This allows prices smaller than one lovelace or one native-token base unit per asset unit. Executed totals are rounded down; check that your intended sale quantity does not round to zero. Registry selection is a UI safeguard; current pool validators do not check registry membership.</p>
        {registry && registry.entries.length === 0 && <p>No issuer-approved assets yet. <Link href="/registry">Review asset requests</Link> before posting a price.</p>}
        <div className="marketplace-toolbar"><button type="button" onClick={stage} disabled={!registry || !form.unit}>Add / update draft</button><button type="button" className="primary-button" disabled={!dirty} onClick={() => void submit()}>Sign on-chain price update</button><button type="button" disabled={!dirty} onClick={() => { setPrices(pool.prices); setDirty(false); }}>Discard draft</button></div>
      </fieldset>
      <h3>Open inventory · {pool.count.toString()} listings</h3><p>Acquisition cost: {quoteAmount(pool.cost)} · Aggregate ask: {quoteAmount(pool.inventory)}. Ask value is not cash.</p>
      {inventory?.listings.map((listing) => <article className="position-card" key={listing.id}><div><code>{listing.unit}</code><p>{listing.quantity.toString()} units · Total ask {quoteAmount(listing.price)} · Cost {listing.settlement.kind === "pool" ? quoteAmount(listing.settlement.cost) : "Unknown"}</p><label className="field"><span>New total ask · {quoteLabel}</span><input inputMode={adaQuote ? "decimal" : "numeric"} value={asks[listing.id] || ""} onChange={(event) => setAsks({ ...asks, [listing.id]: event.target.value })} /></label></div><button type="button" disabled={blocked || !authorized || pool.paused || Boolean(pool.closing) || !asks[listing.id]} onClick={() => void submit(listing)}>Sign inventory reprice</button></article>)}
    </>}
    <MarketTransactionStatus {...transaction} />
  </section>;
}
