"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { WalletAsset } from "@/lib/wallet-assets";
import { fetchPriceBook, instantSellQuote, type PriceBook } from "@/lib/price-book";
import { parseAdaToLovelace } from "@/lib/dex";
import { formatAda } from "@/lib/ada";
import { addressData } from "@/lib/protocol/dex-client";
import { marketplaceDeployment, marketplaceOrderbookAddress, marketplacePoolAddress } from "@/lib/protocol/marketplace-deployment";
import { marketplaceScript, readSharedPool } from "@/lib/protocol/shared-pool-client";
import { readInventory } from "@/lib/protocol/inventory";
import { readRegistry } from "@/lib/asset-registry";
import { useWallet } from "./wallet-context";

export default function PortfolioSale({ asset, onClose, onSubmitted }: { asset: WalletAsset; onClose: () => void; onSubmitted: (hash: string) => void }) {
  const { lucid, address } = useWallet();
  const [mode, setMode] = useState("listing");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [paymentUnit, setPaymentUnit] = useState("");
  const [book, setBook] = useState<PriceBook | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setBook(null); setHeld(null); setQuoteError("");
    if (!lucid) return;
    void (async () => {
      const tools = await import("@lucid-evolution/lucid");
      const [prices, inventory] = await Promise.all([fetchPriceBook(), readInventory(lucid, tools)]);
      if (!cancelled) { setBook(prices.book); setHeld(inventory.holdings[asset.unit] || BigInt(0)); }
    })().catch((error) => { if (!cancelled) setQuoteError(error instanceof Error ? error.message : "Instant Sell unavailable."); });
    return () => { cancelled = true; };
  }, [lucid, asset.unit, revision]);
  let quote: ReturnType<typeof instantSellQuote> | null = null;
  let unavailable = quoteError || "Loading operator prices…";
  try {
    if (book && held !== null) quote = instantSellQuote(book, asset.unit, BigInt(quantity), held);
  } catch (error) { unavailable = error instanceof Error ? error.message : "Enter a valid quantity."; }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!lucid || !address || hash) return;
    setBusy(true); setMessage("");
    try {
      if (!/^[1-9][0-9]*$/.test(quantity)) throw new Error("Enter a positive whole-token quantity in base units.");
      const amount = BigInt(quantity);
      if (amount > asset.quantity) throw new Error("Quantity exceeds your displayed wallet balance.");
      if (await lucid.wallet().address() !== address) throw new Error("Wallet changed. Reconnect before selling.");
      const balance = (await lucid.wallet().getUtxos()).reduce((sum, utxo) => sum + (utxo.assets[asset.unit] || BigInt(0)), BigInt(0));
      if (amount > balance) throw new Error("Wallet balance changed. Refresh Portfolio before selling.");
      const tools = await import("@lucid-evolution/lucid");
      const key = tools.getAddressDetails(address).paymentCredential;
      if (key?.type !== "Key") throw new Error("A payment-key wallet is required.");
      const token = (unit: string) => new tools.Constr(0, [unit.slice(0, 56), unit.slice(56)]);
      let target = marketplaceOrderbookAddress;
      let datum;
      if (mode === "instant") {
        if (!book || !quote) throw new Error("Load an active operator price before requesting a sale.");
        const [latest, pool, inventory, registry] = await Promise.all([fetchPriceBook(), readSharedPool(lucid, tools), readInventory(lucid, tools), readRegistry(lucid)]);
        if (latest.book.revision !== book.revision) { setRevision((n) => n + 1); throw new Error("Operator prices changed. Review the refreshed quote before submitting."); }
        const current = instantSellQuote(latest.book, asset.unit, amount, inventory.holdings[asset.unit] || BigInt(0));
        if (!registry.entries.includes(asset.unit)) throw new Error("This exact asset is not currently registered for pool acquisition.");
        if (pool.paused || pool.quote.policyId) throw new Error("The ADA Instant Sell pool is not available.");
        if (pool.cash - current.bid - BigInt(2_000_000) < pool.minimum) throw new Error("The pool currently has insufficient available cash for this request.");
        const script = await marketplaceScript(tools, "pool_sell_request.pool_sell_request.spend", marketplacePoolAddress);
        target = tools.validatorToAddress("Preprod", script);
        datum = new tools.Constr(0, [addressData(tools, address), key.hash, token(marketplaceDeployment.pool.token), token(asset.unit), amount, new tools.Constr(0, ["", ""]), current.bid]);
      } else {
        const unit = paymentUnit.trim().toLowerCase();
        if (unit && !/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit)) throw new Error("Payment asset must be its exact policy ID and hexadecimal asset name.");
        if (unit === asset.unit) throw new Error("The payment asset cannot be the asset you are selling.");
        const payout = unit ? BigInt(price) : parseAdaToLovelace(price);
        if (payout <= BigInt(0)) throw new Error("Listing price must be positive.");
        datum = new tools.Constr(0, [addressData(tools, address), key.hash, new tools.Constr(0, []), token(asset.unit), amount, unit ? token(unit) : new tools.Constr(0, ["", ""]), payout]);
      }
      const tx = await lucid.newTx().pay.ToContract(target, { kind: "inline", value: tools.Data.to(datum) }, { lovelace: BigInt(2_000_000), [asset.unit]: amount }).complete();
      const submitted = await (await tx.sign.withWallet().complete()).submit();
      setHash(submitted); setMessage("Submitted. Wait for confirmation before treating this sale as open."); onSubmitted(submitted);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Sale could not be submitted."); }
    finally { setBusy(false); }
  }
  return <div className="listing-dialog-backdrop"><section className="listing-dialog" role="dialog" aria-modal="true" aria-labelledby="portfolio-sale-title">
    <div className="listing-dialog-heading"><h2 id="portfolio-sale-title">Sell {asset.name}</h2><button type="button" disabled={busy} className="listing-dialog-close" onClick={onClose} aria-label="Close sale">×</button></div>
    <code className="asset-unit">{asset.unit}</code>
    <form onSubmit={submit} className="wallet-listing-form"><fieldset className="module-fieldset" disabled={busy || Boolean(hash)}>
      <div className="marketplace-sell-mode"><button type="button" className={mode === "listing" ? "selected" : ""} onClick={() => setMode("listing")}>List on Marketplace</button><button type="button" className={mode === "instant" ? "selected" : ""} onClick={() => setMode("instant")}>Instant Sell to pool</button></div>
      <label className="field"><span>Quantity · base units (available: {asset.quantity.toString()})</span><input required inputMode="numeric" pattern="[1-9][0-9]*" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
      {mode === "listing" ? <><label className="field"><span>Payment asset ID (blank for ADA)</span><input value={paymentUnit} onChange={(e) => setPaymentUnit(e.target.value)} placeholder="ADA, or exact native asset ID" /></label><label className="field"><span>Total lot price · {paymentUnit ? "payment base units" : "ADA"}</span><input required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label></> : <div className="execution-preview">{quote ? <><p>Operator buy price: {formatAda(BigInt(quote.entry.bid))} ADA per base unit</p><p>Your minimum payout: <strong>{formatAda(quote.bid)} ADA</strong></p><p>Per request: {quote.entry.maxPerRequest} units · Pool inventory: {held?.toString()} / {quote.entry.maxInventory}</p><p>Quote version {book?.revision}. Your asset is escrowed, not immediately paid. The operator must sign settlement at or above your minimum; you can cancel before settlement.</p></> : <p role="status">{unavailable}</p>}<button type="button" onClick={() => setRevision((n) => n + 1)}>Refresh quote</button></div>}
      <p className="wallet-assets-note">The selected tokens and an escrow deposit of at least 2 ADA move to the contract. The deposit is returned on sale or cancellation; network fees apply. Pending requests do not reserve pool capacity.</p>
      <button type="submit" className="primary-button" disabled={mode === "instant" && !quote}>{busy ? "Awaiting wallet…" : mode === "instant" ? "Request sale at this minimum" : "Create listing"}</button>
    </fieldset></form>
    {message && <p role="status" className="form-message">{message}</p>}
    {hash && <p><a href={"https://preprod.cardanoscan.io/transaction/" + hash} target="_blank" rel="noreferrer">Inspect submitted transaction</a> · <Link href="/portfolio/orders">Manage listings & requests</Link></p>}
  </section></div>;
}
