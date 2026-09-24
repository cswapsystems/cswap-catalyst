"use client";
import { useCallback, useEffect, useState } from "react";
import { readSharedPool, assertFreshPool } from "@/lib/protocol/shared-pool-client";
import { readInventory } from "@/lib/protocol/inventory";
import { buildMarketAction, marketUnit, type PoolPrice, type MarketListing } from "@/lib/marketplace";
import { useWallet } from "./wallet-context";
import { useMarketTransaction } from "./use-market-transaction";
import MarketTransactionStatus from "./market-transaction-status";
import OperatorLimitsPanel from "./operator-limits-panel";

export default function PriceBookPanel() {
  const { lucid, address, connect } = useWallet();
  const [pool, setPool] = useState<Awaited<ReturnType<typeof readSharedPool>> | null>(null);
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof readInventory>> | null>(null);
  const [prices, setPrices] = useState<PoolPrice[]>([]);
  const [dirty, setDirty] = useState(false), [error, setError] = useState(""), [authorized, setAuthorized] = useState(false), [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ unit: "", buyN: "", buyD: "1", sellN: "", sellD: "1" });
  const [asks, setAsks] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    setPool(null); setInventory(null); setAuthorized(false); setError(""); setDirty(false);
    if (!lucid || !address) return; setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const current = await readSharedPool(lucid, tools); setPool(current); setPrices(current.prices);
      setAuthorized(tools.getAddressDetails(address).paymentCredential?.hash === current.batcher);
      setInventory(await readInventory(lucid, tools, current));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "On-chain prices unavailable."); }
    finally { setLoading(false); }
  }, [lucid, address]);
  useEffect(() => { void refresh(); }, [refresh]);
  const transaction = useMarketTransaction(refresh);
  const blocked = loading || transaction.busy || Boolean(transaction.hash);
  function stage() {
    try {
      const unit = form.unit.trim().toLowerCase();
      if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit) || unit === (pool && marketUnit(pool.quote))) throw new Error("Choose an exact non-quote asset ID.");
      const number = (text: string) => { if (!/^[1-9][0-9]*$/.test(text)) throw new Error("Use positive integer ratio values."); return BigInt(text); };
      const entry = { asset: { policyId: unit.slice(0, 56), assetName: unit.slice(56) }, buy: { numerator: number(form.buyN), denominator: number(form.buyD) }, sell: { numerator: number(form.sellN), denominator: number(form.sellD) } };
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
      if (listing && !/^[1-9][0-9]*$/.test(asks[listing.id] || "")) throw new Error("Use a positive total ask in quote base units.");
      if (listing && !(await lucid.utxosByOutRef([listing.utxo])).length) throw new Error("Listing was already spent. Refresh inventory.");
      return buildMarketAction(lucid, tools, current.scripts, address, listing ? { kind: "reprice", listing, price: BigInt(asks[listing.id]) } : { kind: "prices", prices }, current);
    }, () => assertFreshPool(lucid, tools, pool));
  }
  return <><section className="work-card form-card price-book-panel">
    <div className="section-heading"><h2>On-chain pool prices & inventory</h2><button type="button" className="refresh-button" disabled={blocked || dirty} onClick={() => void refresh()}>Refresh pool</button></div>
    <p>Posted buy and sell ratios determine future acquisitions. Publishing prices is an on-chain transaction signed by the pool batcher. Existing inventory keeps its own ask until repriced below.</p>
    {!lucid && <button type="button" onClick={() => void connect()}>Connect wallet</button>}
    {error && <p role="alert">{error}</p>}
    {pool && <><p>Quote asset: <code>{marketUnit(pool.quote)}</code>. {pool.quote.policyId ? "All amounts use native quote base units." : "1 ADA = 1,000,000 lovelace."} Payout = floor(quantity × numerator / denominator).</p>{pool.closing && <p role="status">Closing: price updates and new acquisitions disabled.</p>}
      {prices.map((price) => <article className="position-card" key={marketUnit(price.asset)}><div><code>{marketUnit(price.asset)}</code><p>Buy {price.buy.numerator.toString()} / {price.buy.denominator.toString()} · Sell {price.sell.numerator.toString()} / {price.sell.denominator.toString()} quote base units per asset base unit</p></div><div className="marketplace-actions"><button type="button" disabled={blocked || !authorized || Boolean(pool.closing)} onClick={() => setForm({ unit: marketUnit(price.asset), buyN: price.buy.numerator.toString(), buyD: price.buy.denominator.toString(), sellN: price.sell.numerator.toString(), sellD: price.sell.denominator.toString() })}>Edit draft</button><button type="button" disabled={blocked || !authorized || Boolean(pool.closing)} onClick={() => { setPrices(prices.filter((item) => item !== price)); setDirty(true); }}>Remove price from draft</button></div></article>)}
      {!prices.length && <p>No assets have a posted price. Missing a price prevents new acquisitions.</p>}
      <fieldset className="module-fieldset" disabled={blocked || !authorized || Boolean(pool.closing)}>
        <div className="marketplace-form-grid"><label className="field field-wide"><span>Exact asset ID</span><input value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} /></label>{([["buyN", "Buy numerator · quote base units"], ["buyD", "Buy denominator · asset base units"], ["sellN", "Sell numerator · quote base units"], ["sellD", "Sell denominator · asset base units"]] as const).map(([field, label]) => <label key={field} className="field"><span>{label}</span><input inputMode="numeric" value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} /></label>)}</div>
        <div className="marketplace-toolbar"><button type="button" onClick={stage}>Add / update draft</button><button type="button" className="primary-button" disabled={!dirty} onClick={() => void submit()}>Sign on-chain price update</button><button type="button" disabled={!dirty} onClick={() => { setPrices(pool.prices); setDirty(false); }}>Discard draft</button></div>
      </fieldset>
      <h3>Open inventory · {pool.count.toString()} listings</h3><p>Acquisition cost: {pool.cost.toString()} · Aggregate ask: {pool.inventory.toString()} quote base units. Ask value is not cash.</p>
      {inventory?.listings.map((listing) => <article className="position-card" key={listing.id}><div><code>{listing.unit}</code><p>{listing.quantity.toString()} units · Total ask {listing.price.toString()} quote base units · Cost {listing.settlement.kind === "pool" ? listing.settlement.cost.toString() : "Unknown"}</p><label className="field"><span>New total ask · quote base units</span><input inputMode="numeric" value={asks[listing.id] || ""} onChange={(event) => setAsks({ ...asks, [listing.id]: event.target.value })} /></label></div><button type="button" disabled={blocked || !authorized || pool.paused || Boolean(pool.closing) || !asks[listing.id]} onClick={() => void submit(listing)}>Sign inventory reprice</button></article>)}
    </>}
    <MarketTransactionStatus {...transaction} />
  </section><OperatorLimitsPanel /></>;
}
