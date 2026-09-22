"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchPriceBook, priceUpdate, priceAda, type AssetPrice, type PriceBook } from "@/lib/price-book";
import { marketplaceDeployment } from "@/lib/protocol/marketplace-deployment";
import { readInventory } from "@/lib/protocol/inventory";
import { readRegistry } from "@/lib/asset-registry";
import { parseAdaToLovelace } from "@/lib/dex";
import { formatAda } from "@/lib/ada";
import { useWallet } from "./wallet-context";

export default function PriceBookPanel() {
  const { lucid, address, connect } = useWallet();
  const [book, setBook] = useState<PriceBook | null>(null);
  const [entries, setEntries] = useState<AssetPrice[]>([]);
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof readInventory>> | null>(null);
  const [registered, setRegistered] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [message, setMessage] = useState("");
  const [storage, setStorage] = useState("");
  const [form, setForm] = useState({ unit: "", label: "", bid: "", ask: "", maxPerRequest: "1", maxInventory: "10", active: true });
  const [dirty, setDirty] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true); setMessage(""); setAuthorized(false); setInventory(null);
    try {
      const result = await fetchPriceBook();
      setBook(result.book); setEntries(result.book.entries); setStorage(result.storage); setDirty(false);
      if (lucid && address) {
        const tools = await import("@lucid-evolution/lucid");
        const credential = tools.getAddressDetails(address).paymentCredential;
        setAuthorized(credential?.type === "Key" && credential.hash === result.operatorKey);
        const results = await Promise.allSettled([readInventory(lucid, tools), readRegistry(lucid)]);
        if (results[0].status === "fulfilled") setInventory(results[0].value);
        if (results[1].status === "fulfilled") setRegistered(results[1].value.entries);
        if (results.some((item) => item.status === "rejected")) setMessage("Prices loaded; some on-chain inventory or registry data is unavailable. Refresh before settling requests.");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Prices unavailable."); }
    finally { setBusy(false); }
  }, [lucid, address]);
  useEffect(() => { void refresh(); }, [refresh]);
  const edit = (entry: AssetPrice) => setForm({ ...entry, bid: priceAda(entry.bid), ask: priceAda(entry.ask) });
  function stage() {
    try {
      const entry = { ...form, unit: form.unit.trim().toLowerCase(), bid: parseAdaToLovelace(form.bid).toString(), ask: parseAdaToLovelace(form.ask).toString() };
      const update = priceUpdate(marketplaceDeployment.pool.token, book?.revision || 0, [...entries.filter((item) => item.unit !== entry.unit), entry]);
      setEntries(update.entries); setDirty(true); setMessage("Draft updated. Publish to make these settings available to sellers.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Invalid price."); }
  }
  async function publish() {
    if (!lucid || !address || !book || !authorized) return;
    setBusy(true); setMessage("");
    try {
      const tools = await import("@lucid-evolution/lucid");
      const update = priceUpdate(marketplaceDeployment.pool.token, book.revision, entries);
      if (await lucid.wallet().address() !== address) throw new Error("Wallet changed. Reconnect before publishing.");
      const signature = await lucid.wallet().signMessage(address, tools.fromText(JSON.stringify(update)));
      const response = await fetch("/api/price-book", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, update, signature }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Publishing failed.");
      setBook(result.book); setEntries(result.book.entries); setDirty(false); setMessage("Operator prices published. New requests and acquisitions use this price book.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Publishing failed."); }
    finally { setBusy(false); }
  }
  return <section className="work-card form-card price-book-panel">
    <div className="section-heading"><h2>Instant Sell control panel</h2><button type="button" className="refresh-button" disabled={busy || dirty} onClick={() => void refresh()}>Reload prices</button></div>
    <p>You set the price the pool pays, its resale price, and how much it can hold. No oracle is used. Each acquisition still needs your wallet signature.</p>
    <p className="wallet-assets-note">Prices are ADA per base token unit, not per lot. Limits are checked by this application at request and settlement time; they are not new on-chain guarantees. Existing inventory keeps its original on-chain resale ask.</p>
    {book && <p>Published version {book.revision} · {book.updatedAt ? new Date(book.updatedAt).toLocaleString() : "No prices published"} · {storage}</p>}
    {!lucid && <button type="button" onClick={() => void connect()}>Connect operator wallet</button>}
    {lucid && !authorized && <p>Only the configured operator wallet may publish prices.</p>}
    <div className="price-book-entries">{entries.map((entry) => <article className="position-card" key={entry.unit}><div><h3>{entry.label || "Asset"} · {entry.active ? "Active" : "Inactive"}</h3><code>{entry.unit}</code><p>Buy {formatAda(BigInt(entry.bid))} ADA / unit · Resell {formatAda(BigInt(entry.ask))} ADA / unit</p><p>Request limit {entry.maxPerRequest} · Inventory {inventory ? (inventory.holdings[entry.unit] || BigInt(0)).toString() : "Unknown"} / {entry.maxInventory}</p></div><div className="marketplace-actions"><button type="button" disabled={busy || !authorized} onClick={() => edit(entry)}>Edit</button><button type="button" disabled={busy || !authorized} onClick={() => { setEntries(entries.map((item) => item.unit === entry.unit ? { ...item, active: !item.active } : item)); setDirty(true); }}>{entry.active ? "Deactivate" : "Activate"}</button></div></article>)}</div>
    {book && !entries.length && <p>No assets priced yet. Add a supported asset below.</p>}
    <fieldset className="module-fieldset" disabled={busy || !authorized || !book}>
      <div className="marketplace-form-grid">
        <label className="field field-wide"><span>Exact asset ID</span><input list="registered-price-assets" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="Policy ID + asset name in hex" /><datalist id="registered-price-assets">{registered.map((unit) => <option key={unit} value={unit} />)}</datalist></label>
        <label className="field"><span>Display label</span><input maxLength={100} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
        <label className="field"><span>Buy price (ADA per base unit)</span><input inputMode="decimal" value={form.bid} onChange={(e) => setForm({ ...form, bid: e.target.value })} /></label>
        <label className="field"><span>Resale price (ADA per base unit)</span><input inputMode="decimal" value={form.ask} onChange={(e) => setForm({ ...form, ask: e.target.value })} /></label>
        <label className="field"><span>Maximum units per request</span><input inputMode="numeric" value={form.maxPerRequest} onChange={(e) => setForm({ ...form, maxPerRequest: e.target.value })} /></label>
        <label className="field"><span>Maximum units in pool inventory</span><input inputMode="numeric" value={form.maxInventory} onChange={(e) => setForm({ ...form, maxInventory: e.target.value })} /></label>
        <label><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Accept Instant Sell requests</label>
      </div>
      <div className="marketplace-toolbar"><button type="button" onClick={stage}>Add / update draft asset</button><button type="button" className="primary-button" disabled={!dirty} onClick={() => void publish()}>{busy ? "Awaiting wallet…" : "Sign & publish prices"}</button><button type="button" disabled={!dirty} onClick={() => { setEntries(book?.entries || []); setDirty(false); setMessage("Unpublished changes discarded."); }}>Discard draft</button></div>
    </fieldset>
    {message && <p role="status" className="form-message">{message}</p>}
    <h3>Shared pool inventory</h3>
    {inventory ? inventory.listings.length ? inventory.listings.map((item) => <article className="position-card" key={item.id}><div><code>{item.unit}</code><p>{item.quantity.toString()} units · on-chain lot ask {formatAda(item.ask)} ADA</p></div><Link href="/marketplace">View in Marketplace</Link></article>) : <p>No pool-owned listings.</p> : <p>Connect a wallet and refresh to verify inventory quantities.</p>}
    <p><Link href="/team">Review pending requests</Link> · <Link href="/registry">Manage supported assets</Link></p>
  </section>;
}
