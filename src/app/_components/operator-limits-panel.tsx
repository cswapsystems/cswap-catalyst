"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchPriceBook, priceUpdate, type AssetPrice, type PriceBook } from "@/lib/price-book";
import { marketplaceDeployment } from "@/lib/protocol/marketplace-deployment";
import { readInventory } from "@/lib/protocol/inventory";
import { readRegistry } from "@/lib/asset-registry";


import { useWallet } from "./wallet-context";

export default function OperatorLimitsPanel() {
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
        if (results.some((item) => item.status === "rejected")) setMessage("Limits loaded; some on-chain inventory or registry data is unavailable. Refresh before settling requests.");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Limits unavailable."); }
    finally { setBusy(false); }
  }, [lucid, address]);
  useEffect(() => { void refresh(); }, [refresh]);
  const edit = (entry: AssetPrice) => setForm({ ...entry });
  function stage() {
    try {
      const entry = { ...form, unit: form.unit.trim().toLowerCase(), bid: form.bid || "1", ask: form.ask || "1" };
      const update = priceUpdate(marketplaceDeployment.pool.token, book?.revision || 0, [...entries.filter((item) => item.unit !== entry.unit), entry]);
      setEntries(update.entries); setDirty(true); setMessage("Draft updated. Publish to make these settings available to sellers.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Invalid limits."); }
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
      setBook(result.book); setEntries(result.book.entries); setDirty(false); setMessage("Operator limits published. New requests and acquisitions check these limits.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Publishing failed."); }
    finally { setBusy(false); }
  }
  return <section className="work-card form-card price-book-panel">
    <div className="section-heading"><h2>Off-chain quantity & activity controls</h2><button type="button" className="refresh-button" disabled={busy || dirty} onClick={() => void refresh()}>Reload limits</button></div>
    <p>Set per-request quantity, total inventory caps and activity for each exact asset. These are additional application checks, signed as an operator message.</p>
    <p className="wallet-assets-note">Prices come only from the pool datum above. These limits are not enforced by the validator. The legacy storage format retains old price fields for compatibility; those values are never used for new execution.</p>
    {book && <p>Published version {book.revision} · {book.updatedAt ? new Date(book.updatedAt).toLocaleString() : "No limits published"} · {storage}</p>}
    {!lucid && <button type="button" onClick={() => void connect()}>Connect operator wallet</button>}
    {lucid && !authorized && <p>Only the configured operator wallet may publish limits.</p>}
    <div className="price-book-entries">{entries.map((entry) => <article className="position-card" key={entry.unit}><div><h3>{entry.label || "Asset"} · {entry.active ? "Active" : "Inactive"}</h3><code>{entry.unit}</code><p>Request limit {entry.maxPerRequest} · Inventory {inventory ? (inventory.holdings[entry.unit] || BigInt(0)).toString() : "Unknown"} / {entry.maxInventory}</p></div><div className="marketplace-actions"><button type="button" disabled={busy || !authorized} onClick={() => edit(entry)}>Edit</button><button type="button" disabled={busy || !authorized} onClick={() => { setEntries(entries.map((item) => item.unit === entry.unit ? { ...item, active: !item.active } : item)); setDirty(true); }}>{entry.active ? "Deactivate" : "Activate"}</button></div></article>)}</div>
    {book && !entries.length && <p>No asset limits configured yet. Add a supported asset below.</p>}
    <fieldset className="module-fieldset" disabled={busy || !authorized || !book}>
      <div className="marketplace-form-grid">
        <label className="field field-wide"><span>Exact asset ID</span><input list="registered-price-assets" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="Policy ID + asset name in hex" /><datalist id="registered-price-assets">{registered.map((unit) => <option key={unit} value={unit} />)}</datalist></label>
        <label className="field"><span>Display label</span><input maxLength={100} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
        <label className="field"><span>Maximum units per request</span><input inputMode="numeric" value={form.maxPerRequest} onChange={(e) => setForm({ ...form, maxPerRequest: e.target.value })} /></label>
        <label className="field"><span>Maximum units in pool inventory</span><input inputMode="numeric" value={form.maxInventory} onChange={(e) => setForm({ ...form, maxInventory: e.target.value })} /></label>
        <label><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Accept Instant Sell requests</label>
      </div>
      <div className="marketplace-toolbar"><button type="button" onClick={stage}>Add / update draft asset</button><button type="button" className="primary-button" disabled={!dirty} onClick={() => void publish()}>{busy ? "Awaiting wallet…" : "Sign & publish limits"}</button><button type="button" disabled={!dirty} onClick={() => { setEntries(book?.entries || []); setDirty(false); setMessage("Unpublished changes discarded."); }}>Discard draft</button></div>
    </fieldset>
    {message && <p role="status" className="form-message">{message}</p>}
    <p><Link href="/team">Review pending requests</Link> · <Link href="/registry">Manage supported assets</Link></p>
  </section>;
}
