"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet-context";
import { readSharedPool, assertFreshPool } from "@/lib/protocol/shared-pool-client";
import { marketplaceOrderbookAddress } from "@/lib/protocol/marketplace-deployment";
import { readInventory } from "@/lib/protocol/inventory";
import { fetchPriceBook, checkOperatorLimits, type PriceBook } from "@/lib/price-book";
import { buildMarketAction, decodeMarketListing, marketUnit, postedQuote, type MarketListing } from "@/lib/marketplace";
import { scanOutputs } from "@/lib/safe-scan";
import { formatAda } from "@/lib/ada";
import { useMarketTransaction } from "./use-market-transaction";
import MarketTransactionStatus from "./market-transaction-status";

export default function TeamWorkbench({ onSettled }: { onSettled?: () => Promise<void> }) {
  const { lucid, address } = useWallet();
  const [pool, setPool] = useState<Awaited<ReturnType<typeof readSharedPool>> | null>(null);
  const [requests, setRequests] = useState<MarketListing[]>([]);
  const [limits, setLimits] = useState<PriceBook | null>(null), [held, setHeld] = useState<Record<string, bigint>>({});
  const [error, setError] = useState(""), [limitError, setLimitError] = useState("");
  const [authorized, setAuthorized] = useState(false), [loading, setLoading] = useState(false);
  const [receipt, setReceipt] = useState<Record<string, string> | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    setPool(null); setRequests([]); setLimits(null); setAuthorized(false); setError(""); setLimitError("");
    if (!lucid || !address) return;
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const current = await readSharedPool(lucid, tools); setPool(current);
      setAuthorized(tools.getAddressDetails(address).paymentCredential?.hash === current.batcher);
      const found = scanOutputs(await lucid.utxosAt(marketplaceOrderbookAddress), (utxo) => utxo.datum ? decodeMarketListing(tools, utxo) : null);
      setRequests(found.items.filter((listing) => listing.settlement.kind === "instant" && marketUnit(listing.settlement.poolToken) === marketUnit(current.poolToken)));
      if (found.skipped) setError(found.skipped + " unreadable orderbook outputs skipped.");
      // Queue visibility is independent of off-chain storage availability.
      try { const [book, inventory] = await Promise.all([fetchPriceBook(), readInventory(lucid, tools, current)]); setLimits(book.book); setHeld(inventory.holdings); }
      catch (cause) { setLimitError(cause instanceof Error ? cause.message : "Operator limits unavailable. Acquisition disabled."); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Queue unavailable."); }
    finally { setLoading(false); }
  }, [lucid, address]);
  useEffect(() => { void refresh(); }, [refresh]);
  const transaction = useMarketTransaction(async () => { await refresh(); await onSettled?.(); });
  const display = (amount: bigint) => pool?.quote.policyId ? amount.toString() + " quote base units" : formatAda(amount) + " ADA";
  async function acquire(listing: MarketListing) {
    if (!lucid || !pool || !limits) return;
    const tools = await import("@lucid-evolution/lucid");
    let approval: Record<string, string> = {};
    await transaction.run(async () => {
      const current = await assertFreshPool(lucid, tools, pool);
      const [latest, inventory] = await Promise.all([fetchPriceBook(), readInventory(lucid, tools, current)]);
      if (latest.book.revision !== limits.revision) throw new Error("Operator limits changed. Refresh before approving.");
      checkOperatorLimits(latest.book, marketUnit(listing.rwa), listing.quantity, inventory.holdings[marketUnit(listing.rwa)] || BigInt(0));
      const available = (await lucid.utxosByOutRef([listing.utxo]))[0];
      if (!available || available.datum !== listing.utxo.datum) throw new Error("Seller listing changed or was cancelled.");
      if (!references[listing.id]?.trim()) throw new Error("Enter an approval reference.");
      const quote = postedQuote(current, marketUnit(listing.rwa), listing.quantity);
      approval = { operator: address, approval: references[listing.id].trim(), listingRef: listing.id, poolRef: `${current.utxo.txHash}#${current.utxo.outputIndex}`, limitsRevision: String(latest.book.revision), bid: quote.bid.toString(), ask: quote.ask.toString(), quoteUnit: marketUnit(current.quote), expectedCash: (current.cash - quote.bid).toString(), createdAt: new Date().toISOString() };
      return buildMarketAction(lucid, tools, current.scripts, address, { kind: "acquire", listing: decodeMarketListing(tools, available) }, current);
    }, async () => {
      await assertFreshPool(lucid, tools, pool);
      if ((await fetchPriceBook()).book.revision !== limits.revision) throw new Error("Operator controls changed during preparation. Refresh.");
    }, (hash) => setReceipt({ ...approval, transactionHash: hash }));
  }
  function downloadReceipt() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "instant-sell-approval.json"; link.click(); URL.revokeObjectURL(url);
  }
  return <section className="work-card form-card"><div className="section-heading"><h2>Approve Instant Sell listings</h2><button type="button" className="refresh-button" disabled={loading || transaction.busy} onClick={() => void refresh()}>Refresh queue</button></div>
    <p>Acquisitions use the current on-chain buy and sell ratios. The batcher funds the new inventory listing’s ADA deposit separately; the pool pays only the posted bid. The protected quote reserve is enforced by the updated validator. Quantity caps and the active switch remain operator controls.</p>
    <p><Link href="/team/inventory">Manage on-chain prices & operator limits</Link></p>
    {!lucid && <p>Connect your wallet to read the queue.</p>}{error && <p role="alert">{error}</p>}{limitError && <p role="alert">{limitError} No acquisitions can be signed until controls are verified.</p>}
    {pool?.closing && <p role="status">Pool is closing. New acquisitions are disabled; the recorded LP recovers inventory from Shared reserves.</p>}
    {requests.map((listing) => {
      let quote: ReturnType<typeof postedQuote> | null = null, blocked = "";
      try {
        if (!pool || !limits) throw new Error("Pool or operator limits unavailable.");
        checkOperatorLimits(limits, marketUnit(listing.rwa), listing.quantity, held[marketUnit(listing.rwa)] || BigInt(0));
        quote = postedQuote(pool, marketUnit(listing.rwa), listing.quantity);
        if (quote.bid < listing.price) throw new Error("Posted bid is below the seller minimum.");
      } catch (cause) { blocked = cause instanceof Error ? cause.message : "Acquisition unavailable."; }
      return <article className="operator-request" key={listing.id}><code>{marketUnit(listing.rwa)}</code><p>{listing.quantity.toString()} base units · Seller minimum {display(listing.price)}</p>{quote && <p>Total bid {display(quote.bid)} · Initial inventory ask {display(quote.ask)} · Cash after acquisition {display(pool!.cash - quote.bid)}</p>}{blocked && <p role="status">{blocked}</p>}<label className="field"><span>Approval reference</span><input value={references[listing.id] || ""} onChange={(event) => setReferences({ ...references, [listing.id]: event.target.value })} /></label><button className="primary-button" type="button" disabled={!authorized || Boolean(blocked) || loading || transaction.busy || Boolean(transaction.hash) || !references[listing.id]?.trim()} onClick={() => void acquire(listing)}>Sign acquisition</button></article>;
    })}
    {!loading && pool && !requests.length && <p>No pending Instant Sell listings for this pool.</p>}
    {receipt && <p><button type="button" onClick={downloadReceipt}>Download approval receipt</button> Archive this session-only record; it does not prove confirmation.</p>}
    <MarketTransactionStatus {...transaction} />
  </section>;
}
