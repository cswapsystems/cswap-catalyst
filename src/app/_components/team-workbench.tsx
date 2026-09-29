"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet-context";
import { readSharedPool, assertFreshPool } from "@/lib/protocol/shared-pool-client";
import { marketplaceOrderbookAddress } from "@/lib/protocol/marketplace-deployment";
import { assessInstantSellAcquisition, buildMarketAction, decodeMarketListing, marketUnit, outputRef, type MarketListing } from "@/lib/marketplace";
import { scanOutputs } from "@/lib/safe-scan";
import { formatAda } from "@/lib/ada";
import { walletAssetName } from "@/lib/wallet-assets";
import { useMarketTransaction } from "./use-market-transaction";
import MarketTransactionStatus from "./market-transaction-status";

export default function TeamWorkbench({ onSettled }: { onSettled?: () => Promise<void> }) {
  const { lucid, address } = useWallet();
  const [pool, setPool] = useState<Awaited<ReturnType<typeof readSharedPool>> | null>(null);
  const [requests, setRequests] = useState<{ listing: MarketListing; sellerKeyMatches: boolean }[]>([]);
  const [error, setError] = useState("");
  const [authorized, setAuthorized] = useState(false), [loading, setLoading] = useState(false);
  const [receipt, setReceipt] = useState<Record<string, string> | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    setPool(null); setRequests([]); setAuthorized(false); setError("");
    if (!lucid || !address) return;
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const current = await readSharedPool(lucid, tools); setPool(current);
      setAuthorized(tools.getAddressDetails(address).paymentCredential?.hash === current.batcher);
      const found = scanOutputs(await lucid.utxosAt(marketplaceOrderbookAddress), (utxo) => utxo.datum ? decodeMarketListing(tools, utxo) : null);
      setRequests(found.items.filter((listing) => listing.settlement.kind === "instant" && marketUnit(listing.settlement.poolToken) === marketUnit(current.poolToken)).map((listing) => {
        const payment = tools.getAddressDetails(listing.seller).paymentCredential;
        return { listing, sellerKeyMatches: payment?.type === "Key" && payment.hash === listing.sellerKey };
      }));
      if (found.skipped) setError(found.skipped + " unreadable orderbook outputs skipped.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Queue unavailable."); }
    finally { setLoading(false); }
  }, [lucid, address]);
  useEffect(() => { void refresh(); }, [refresh]);
  const transaction = useMarketTransaction(async () => { await refresh(); await onSettled?.(); }, "instant sell acquisition");
  const display = (amount: bigint) => pool?.quote.policyId ? amount.toString() + " quote base units" : formatAda(amount) + " ADA";
  async function acquire(listing: MarketListing) {
    if (!lucid || !pool) return;
    const tools = await import("@lucid-evolution/lucid");
    let approval: Record<string, string> = {};
    await transaction.run(async () => {
      const current = await assertFreshPool(lucid, tools, pool);
      const available = (await lucid.utxosByOutRef([listing.utxo]))[0];
      if (!available || available.datum !== listing.utxo.datum) throw new Error("Seller listing changed or was cancelled.");
      if (!references[listing.id]?.trim()) throw new Error("Enter an approval reference.");
      const freshListing = decodeMarketListing(tools, available);
      const sellerPayment = tools.getAddressDetails(freshListing.seller).paymentCredential;
      const review = assessInstantSellAcquisition(current, freshListing, marketplaceOrderbookAddress, sellerPayment?.type === "Key" && sellerPayment.hash === freshListing.sellerKey);
      if (review.issues.length || !review.quote) throw new Error(review.issues.join(" ") || "Current pool quote is unavailable.");
      approval = { operator: address, approval: references[listing.id].trim(), listingRef: listing.id, poolRef: outputRef(current.utxo), seller: freshListing.seller, assetUnit: marketUnit(freshListing.rwa), quantity: freshListing.quantity.toString(), sellerMinimum: freshListing.price.toString(), escrowLovelace: freshListing.lockedLovelace.toString(), bid: review.quote.bid.toString(), ask: review.quote.ask.toString(), quoteUnit: marketUnit(current.quote), expectedCash: (current.cash - review.quote.bid).toString(), createdAt: new Date().toISOString() };
      return buildMarketAction(lucid, tools, current.scripts, address, { kind: "acquire", listing: freshListing }, current);
    }, () => assertFreshPool(lucid, tools, pool), (hash) => setReceipt({ ...approval, transactionHash: hash }));
  }
  function downloadReceipt() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "instant-sell-approval.json"; link.click(); URL.revokeObjectURL(url);
  }
  return <section className="work-card form-card"><div className="section-heading"><h2>Approve Instant Sell listings</h2><button type="button" className="refresh-button" disabled={loading || transaction.busy} onClick={() => void refresh()}>Refresh queue</button></div>
    <p>Review each seller, exact asset, escrow and current pool bid before signing. The pool pays the posted bid; the operator funds the new inventory output’s ADA buffer separately. A pending request does not reserve pool cash.</p>
    <p><Link href="/team/inventory">Manage on-chain prices</Link></p>
    {!lucid && <p>Connect your wallet to read the queue.</p>}{error && <p role="alert">{error}</p>}
    {pool?.closing && <p role="status">Pool is closing. New acquisitions are disabled; the recorded LP recovers inventory from Shared reserves.</p>}
    {pool && <div className="operator-queue-status"><strong>{requests.length} matching Instant Sell escrow{requests.length === 1 ? "" : "s"} found</strong><span>Each shown UTxO passed inline-datum and exact locked-value decoding. Pool snapshot <code>{outputRef(pool.utxo)}</code>. Refresh after any chain change; the UTxO and pool are rechecked before signing.</span></div>}
    {requests.map(({ listing, sellerKeyMatches }) => {
      const review = pool ? assessInstantSellAcquisition(pool, listing, marketplaceOrderbookAddress, sellerKeyMatches) : { quote: null, issues: ["Pool unavailable."] };
      const unit = marketUnit(listing.rwa);
      return <article className="operator-request" key={listing.id}>
        <div className="operator-request-head"><div><span className="section-kicker">Verified inline-datum escrow</span><h3>{walletAssetName(listing.rwa.assetName)}</h3></div><span className={review.issues.length ? "operator-request-state blocked" : "operator-request-state"}>{review.issues.length ? "Needs review" : "Ready to acquire"}</span></div>
        <div className="operator-request-identities"><div><span>Exact asset ID</span><code>{unit}</code><Link href={"/assets?asset=" + encodeURIComponent(unit)}>Inspect asset ↗</Link></div><div><span>Seller payout address</span><code>{listing.seller}</code><a href={"https://preprod.cexplorer.io/address/" + listing.seller} target="_blank" rel="noreferrer">Inspect seller address ↗</a></div><div><span>Escrow UTxO · current orderbook</span><code>{listing.id}</code><a href={"https://preprod.cexplorer.io/tx/" + listing.utxo.txHash} target="_blank" rel="noreferrer">Inspect transaction ↗</a></div></div>
        <dl className="operator-request-metrics"><div><dt>Quantity</dt><dd>{listing.quantity.toString()} asset base units</dd></div><div><dt>Seller minimum</dt><dd>{display(listing.price)}</dd></div><div><dt>Current pool bid</dt><dd>{review.quote ? display(review.quote.bid) : "Unavailable"}</dd></div><div><dt>Initial inventory ask</dt><dd>{review.quote ? display(review.quote.ask) : "Unavailable"}</dd></div><div><dt>Escrow ADA returned to seller</dt><dd>{formatAda(listing.lockedLovelace)} ADA</dd></div><div><dt>Cash after acquisition</dt><dd>{review.quote && pool ? display(pool.cash - review.quote.bid) : "Unavailable"}</dd></div></dl>
        <p className="operator-request-check">Datum, token quantity and locked value match the orderbook UTxO. {sellerKeyMatches ? "Seller signing key matches the payout address." : "Seller signing key does not match the payout address."} Quote asset: <code>{pool ? marketUnit(pool.quote) : "Unavailable"}</code>. Protected reserve: {pool ? display(pool.minimum) : "Unavailable"}.</p>
        {review.issues.length > 0 && <div className="operator-request-issues" role="status"><strong>Cannot acquire yet</strong><ul>{review.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
        <label className="field"><span>Approval reference</span><input value={references[listing.id] || ""} onChange={(event) => setReferences({ ...references, [listing.id]: event.target.value })} placeholder="Internal review or ticket ID" /></label><p className="operator-request-note">This reference is included in the downloadable session receipt, not written on-chain. Confirm the asset and seller independently before signing.</p>
        <button className="primary-button" type="button" disabled={!authorized || review.issues.length > 0 || loading || transaction.busy || Boolean(transaction.hash) || !references[listing.id]?.trim()} onClick={() => void acquire(listing)}>Sign acquisition</button>
      </article>;
    })}
    {!loading && pool && !requests.length && <p>No pending Instant Sell listings for this pool.</p>}
    {receipt && <p><button type="button" onClick={downloadReceipt}>Download approval receipt</button> Archive this session-only record; it does not prove confirmation.</p>}
    <MarketTransactionStatus {...transaction} />
  </section>;
}
