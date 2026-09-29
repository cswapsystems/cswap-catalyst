"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { WalletAsset } from "@/lib/wallet-assets";
import { parseAdaToLovelace } from "@/lib/dex";
import { formatAda } from "@/lib/ada";
import { addressData } from "@/lib/protocol/dex-client";
import { marketplaceOrderbookAddress } from "@/lib/protocol/marketplace-deployment";
import { reviewedOrderbook, readSharedPool, assertFreshPool, assertMarketWallet } from "@/lib/protocol/shared-pool-client";
import { postedQuote, listingDatum, marketUnit, outputRef } from "@/lib/marketplace";
import { useWallet } from "./wallet-context";
import { confirmTransaction } from "@/lib/transaction-confirmation";

export default function PortfolioSale({ asset, onClose, onConfirmed }: { asset: WalletAsset; onClose: () => void; onConfirmed: () => void }) {
  const { lucid, address } = useWallet();
  const [mode, setMode] = useState("listing");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [paymentUnit, setPaymentUnit] = useState("");
  const [pool, setPool] = useState<Awaited<ReturnType<typeof readSharedPool>> | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPool(null); setQuoteError("");
    if (!lucid) return;
    void (async () => {
      const tools = await import("@lucid-evolution/lucid");
      const current = await readSharedPool(lucid, tools);
      if (!cancelled) setPool(current);
    })().catch((error) => { if (!cancelled) setQuoteError(error instanceof Error ? error.message : "Instant Sell unavailable."); });
    return () => { cancelled = true; };
  }, [lucid, asset.unit, revision]);
  let quote: ReturnType<typeof postedQuote> | null = null;
  let unavailable = quoteError || "Loading on-chain pool prices…";
  try {
    if (pool) quote = postedQuote(pool, asset.unit, BigInt(quantity));
  } catch (error) { unavailable = error instanceof Error ? error.message : "Enter a valid quantity."; }
  const missingPostedPrice = Boolean(pool && !pool.paused && !pool.closing && !pool.prices.some((entry) => marketUnit(entry.asset) === asset.unit));
  async function checkConfirmation(submitted: string, manual = false) {
    setConfirming(true);
    setMessage("");
    try {
      if (manual) {
        const response = await fetch("/api/blockfrost/txs/" + submitted, { cache: "no-store" });
        if (!response.ok) throw new Error("Confirmation is not available yet. Check the transaction before retrying.");
      } else if (!lucid || !await confirmTransaction(lucid, submitted)) {
        throw new Error("Confirmation is not available yet. Check the transaction before retrying.");
      }
      onConfirmed();
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Confirmation could not be checked. Use the explorer and check again.");
    } finally {
      setConfirming(false);
    }
  }
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
      const target = marketplaceOrderbookAddress;
      await reviewedOrderbook(tools);
      let datum;
      if (mode === "instant") {
        if (!quote || !pool) throw new Error("Load a current on-chain quote first.");
        const current = await assertFreshPool(lucid, tools, pool);
        const payout = postedQuote(current, asset.unit, amount);
        datum = listingDatum(tools, { seller: address, sellerKey: key.hash, settlement: { kind: "instant", poolToken: current.poolToken }, rwa: { policyId: asset.policyId, assetName: asset.nameHex }, quantity: amount, priceAsset: current.quote, price: payout.bid });
      } else {
        const unit = paymentUnit.trim().toLowerCase();
        if (unit && !/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit)) throw new Error("Payment asset must be its exact policy ID and hexadecimal asset name.");
        if (unit === asset.unit) throw new Error("The payment asset cannot be the asset you are selling.");
        const payout = unit ? BigInt(price) : parseAdaToLovelace(price);
        if (payout <= BigInt(0)) throw new Error("Listing price must be positive.");
        datum = new tools.Constr(0, [addressData(tools, address), key.hash, new tools.Constr(0, []), token(asset.unit), amount, unit ? token(unit) : new tools.Constr(0, ["", ""]), payout]);
      }
      const tx = await lucid.newTx().pay.ToContract(target, { kind: "inline", value: tools.Data.to(datum) }, { lovelace: BigInt(2_000_000), [asset.unit]: amount }).complete();
      if (mode === "instant" && pool) await assertFreshPool(lucid, tools, pool);
      await assertMarketWallet(lucid, address);
      const submitted = await (await tx.sign.withWallet().complete()).submit();
      setHash(submitted);
      void checkConfirmation(submitted);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Sale could not be submitted."); }
    finally { setBusy(false); }
  }
  return <div className="listing-dialog-backdrop"><section className="listing-dialog" role="dialog" aria-modal="true" aria-labelledby="portfolio-sale-title">
    <div className="listing-dialog-heading"><h2 id="portfolio-sale-title">Sell {asset.name}</h2><button type="button" disabled={busy} className="listing-dialog-close" onClick={onClose} aria-label="Close sale">×</button></div>
    <code className="asset-unit">{asset.unit}</code>
    <form onSubmit={submit} className="wallet-listing-form"><fieldset className="module-fieldset" disabled={busy || Boolean(hash)}>
      <div className="marketplace-sell-mode" role="group" aria-label="Sale method"><button type="button" aria-pressed={mode === "listing"} className={mode === "listing" ? "selected" : ""} onClick={() => setMode("listing")}>List on Marketplace</button><button type="button" aria-pressed={mode === "instant"} className={mode === "instant" ? "selected" : ""} onClick={() => setMode("instant")}>Request Instant Sell</button></div>
      <p className="sale-method-note">{mode === "listing" ? "Set your total asking price. A buyer can accept the listing on Marketplace." : "Set a minimum payout from the live pool quote. Team approval and on-chain settlement happen after you submit."}</p>
      <label className="field"><span>Quantity · base units (available: {asset.quantity.toString()})</span><input required inputMode="numeric" pattern="[1-9][0-9]*" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
      {mode === "listing" ? <><label className="field"><span>Payment asset ID (blank for ADA)</span><input value={paymentUnit} onChange={(e) => setPaymentUnit(e.target.value)} placeholder="ADA, or exact native asset ID" /></label><label className="field"><span>Total lot price · {paymentUnit ? "payment base units" : "ADA"}</span><input required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label></> : <div className="execution-preview sale-quote-preview"><span className="sale-preview-label">On-chain pool quote</span>{quote ? <><strong className="sale-preview-amount">{pool?.quote.policyId ? quote.bid.toString() + " quote base units" : formatAda(quote.bid) + " ADA"}</strong><p>Minimum total payout for {quantity} base unit{quantity === "1" ? "" : "s"}. This is a request, not an immediate payment.</p><details><summary>Quote details</summary><p>Quote asset: <code>{pool?.quote.policyId ? pool.quote.policyId + pool.quote.assetName : "ADA"}</code></p><p>Pool snapshot: <code>{pool && outputRef(pool.utxo)}</code></p><p>Calculated with integer rounding from the posted buy ratio. Pending requests do not reserve pool cash.</p></details></> : <><strong className="sale-preview-unavailable">Quote unavailable</strong><p role="status">{unavailable}</p>{missingPostedPrice && <p>This asset has no posted pool buy price. <Link href="/portfolio/asset-requests">Check asset support</Link> or ask Team to add an on-chain price before requesting Instant Sell.</p>}</>}<button type="button" className="sale-quote-refresh" onClick={() => setRevision((n) => n + 1)}>Refresh quote</button></div>}
      <p className="wallet-assets-note">Your selected tokens and at least 2 ADA move into escrow. The deposit is returned on sale or cancellation; network fees apply. {mode === "instant" ? "Team must settle at or above your minimum, or you can cancel before settlement." : "The buyer pays your listed total price."}</p>
      <button type="submit" className="primary-button" disabled={mode === "instant" && !quote}>{busy ? "Awaiting wallet…" : mode === "instant" ? "Request sale at this minimum" : "Create listing"}</button>
    </fieldset></form>
    {confirming && <p className="sale-confirmation-progress" role="status"><span className="sale-confirmation-spinner" aria-hidden="true" />Transaction submitted. Waiting for network confirmation…</p>}
    {message && <p role="status" className="form-message">{message}</p>}
    {hash && <p><a href={"https://preprod.cardanoscan.io/transaction/" + hash} target="_blank" rel="noreferrer">Inspect submitted transaction</a> · <Link href="/portfolio/orders">Manage listings & requests</Link>{!confirming && <> · <button type="button" className="sale-confirmation-check" onClick={() => void checkConfirmation(hash, true)}>Check confirmation</button></>}</p>}
  </section></div>;
}
