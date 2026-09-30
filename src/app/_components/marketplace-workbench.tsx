"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useWallet } from "./wallet-context";
import { marketplaceOrderbookAddress } from "@/lib/protocol/marketplace-deployment";
import { formatAda } from "@/lib/ada";
import { decodeMarketListing, buildMarketAction, type MarketListing, type MarketScripts } from "@/lib/marketplace";
import { assertFreshPool, reviewedOrderbook, readSharedPool } from "@/lib/protocol/shared-pool-client";
import { useMarketTransaction } from "./use-market-transaction";
import { assetDisplayName, cachedAssetName, loadAssetNames, rememberAssetName } from "@/lib/asset-display-name";
import MarketTransactionStatus from "./market-transaction-status";
import LegacyRequestRecovery from "./legacy-request-recovery";


type ListingLayout = "card" | "list";
type AssetClass = { policyId: string; assetName: string };
type Constr = { index: number; fields: unknown[] };
type FractionInfo = { fraction: AssetClass; original: AssetClass; totalFractions: bigint };
type Listing = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; seller: string; sellerKey: string; managed: boolean; decoded: MarketListing; settlement: "direct" | "instant" | "pool"; poolToken?: AssetClass; inventoryToken?: AssetClass; fraction?: FractionInfo; rwa: AssetClass; quantity: bigint; priceAsset: AssetClass; price: bigint; lockedLovelace: bigint };


function isConstr(value: unknown): value is Constr {
  return typeof value === "object" && value !== null && "index" in value && "fields" in value &&
    typeof (value as { index: unknown }).index === "number" &&
    Array.isArray((value as { fields: unknown }).fields);
}
function getConstr(value: unknown, label: string): Constr {
  if (!isConstr(value)) throw new Error("Malformed " + label + " datum.");
  return value;
}
function decodeListing(utxo: import("@lucid-evolution/lucid").UTxO, tools: typeof import("@lucid-evolution/lucid")): Listing {
  const decoded = decodeMarketListing(tools, utxo), settlement = decoded.settlement;
  return { ...decoded, decoded, managed: false, settlement: settlement.kind, poolToken: settlement.kind !== "direct" ? settlement.poolToken : undefined, inventoryToken: settlement.kind === "pool" ? settlement.inventoryToken : undefined };
}
function unit(asset: AssetClass): string { return asset.policyId + asset.assetName; }
function assetNameText(assetName: string): string {
  if (!assetName) return "Unnamed asset";
  try {
    const bytes = Uint8Array.from(assetName.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text || "Unnamed asset";
  } catch {
    return "Binary asset";
  }
}
function metadataText(value: unknown): string {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string").join("") : typeof value === "string" ? value : "";
}
function ipfsGatewayUrl(value: unknown): string | null {
  const uri = metadataText(value);
  const cid = uri.startsWith("ipfs://") ? uri.slice(7).split("/")[0] : "";
  return /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(cid) ? "/api/ipfs/gateway/" + cid : null;
}
async function loadFractionIndex(lucid: import("@lucid-evolution/lucid").LucidEvolution): Promise<Map<string, FractionInfo>> {
  const response = await fetch("/api/fractionalize-blueprint", { cache: "no-store" });
  const blueprint = await response.json() as { vaultCompiledCode?: string; error?: string };
  if (!response.ok || !blueprint.vaultCompiledCode) throw new Error(blueprint.error ?? "Fractionalization validator unavailable.");
  const tools = await import("@lucid-evolution/lucid");
  const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "mainnet" ? "Mainnet" as const : "Preprod" as const;
  const vaultAddress = tools.validatorToAddress(network, { type: "PlutusV3", script: blueprint.vaultCompiledCode });
  const index = new Map<string, FractionInfo>();
  for (const utxo of await lucid.utxosAt(vaultAddress)) {
    if (!utxo.datum) continue;
    try {
      const root = getConstr(tools.Data.from(utxo.datum), "vault");
      if (root.index !== 0 || root.fields.length !== 8 || typeof root.fields[2] !== "string" || typeof root.fields[3] !== "string" || typeof root.fields[4] !== "string" || typeof root.fields[5] !== "string" || typeof root.fields[6] !== "bigint") continue;
      const original = { policyId: root.fields[2], assetName: root.fields[3] };
      const fraction = { policyId: root.fields[4], assetName: root.fields[5] };
      index.set(unit(fraction), { fraction, original, totalFractions: root.fields[6] });
    } catch {
      // Ignore unrelated or legacy vault outputs.
    }
  }
  return index;
}
export default function MarketplaceWorkbench({ ownerOnly = false }: { ownerOnly?: boolean }) {
  const { address, lucid, connect, status } = useWallet();
  const [listingLayout, setListingLayout] = useState<ListingLayout>("card");
  const [listings, setListings] = useState<Listing[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [assetNames, setAssetNames] = useState<Record<string, string>>({});
  const [purchasedListingIds] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Listing | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [marketplaceToast, setMarketplaceToast] = useState<string | null>(null);
  const orderbookAddress = marketplaceOrderbookAddress;

  useEffect(() => {
    if (!marketplaceToast) return;
    const timer = window.setTimeout(() => setMarketplaceToast(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [marketplaceToast]);


  const refresh = useCallback(async () => {
    setMessage(null);
    if (!lucid || !orderbookAddress) { setListings([]); setLoaded(true); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      await reviewedOrderbook(tools);
      let fractions = new Map<string, FractionInfo>();
      try { fractions = await loadFractionIndex(lucid); } catch { /* Fraction metadata is optional for generic listings. */ }
      const found: Listing[] = [];
      const orderbookUtxos = await lucid.utxosAt(orderbookAddress);
      for (const utxo of orderbookUtxos) {
        if (!utxo.datum) continue;
        try {
          const listing = decodeListing(utxo, tools);
          const details = address ? tools.getAddressDetails(address) : undefined;
          const managed = details?.paymentCredential?.type === "Key" && details.paymentCredential.hash === listing.sellerKey;
          found.push({ ...listing, managed, fraction: fractions.get(unit(listing.rwa)) });
        } catch { /* skip unrelated script UTxOs */ }
      }
      setListings(ownerOnly ? found.filter((listing) => listing.managed && listing.settlement !== "pool") : found); setLoaded(true);
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to read orderbook listings." });
    } finally { setLoading(false); }
  }, [address, lucid, orderbookAddress, ownerOnly]);

  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    const units = [...new Set(listings.map((listing) => unit(listing.rwa)))];
    const originalUnits = [...new Set(listings.flatMap((listing) => listing.fraction ? [unit(listing.fraction.original)] : []))];
    const quoteUnits = [...new Set(listings.flatMap((listing) => listing.priceAsset.policyId ? [unit(listing.priceAsset)] : []))];
    if (units.length === 0) { setThumbnails({}); return; }
    setAssetNames((current) => ({ ...current, ...Object.fromEntries([...units, ...originalUnits, ...quoteUnits].map((assetUnit) => [assetUnit, cachedAssetName(assetUnit)]).filter(([, name]) => Boolean(name))) }));
    void loadAssetNames([...originalUnits, ...quoteUnits]).then((names) => { if (!cancelled) setAssetNames((current) => ({ ...current, ...names })); });
    void Promise.all(units.map(async (assetUnit) => {
      try {
        const response = await fetch("/api/blockfrost/assets/" + encodeURIComponent(assetUnit), { cache: "force-cache" });
        if (!response.ok) return null;
        const asset = await response.json() as { onchain_metadata?: { image?: unknown; name?: unknown } };
        const name = rememberAssetName(assetUnit, asset.onchain_metadata);
        const thumbnail = ipfsGatewayUrl(asset.onchain_metadata?.image);
        return [assetUnit, thumbnail, name] as const;
      } catch { return null; }
    })).then((results) => {
      if (!cancelled) {
        setThumbnails(Object.fromEntries(results.flatMap((result) => result?.[1] ? [[result[0], result[1]] as const] : [])));
        setAssetNames((current) => ({ ...current, ...Object.fromEntries(results.filter((result): result is readonly [string, string | null, string] => result !== null && Boolean(result[2])).map(([assetUnit, , name]) => [assetUnit, name])) }));
      }
    });
    return () => { cancelled = true; };
  }, [listings]);
  const p2pListings = useMemo(() => listings.filter((listing) => listing.settlement === "direct"), [listings]);
  const poolListings = useMemo(() => listings.filter((listing) => listing.settlement === "pool"), [listings]);

  const transaction = useMarketTransaction(refresh, "marketplace listing or purchase", (confirmed) => {
    if (confirmed.operation !== "instant sell cancellation") return false;
    setMarketplaceToast("Instant Sell order cancelled. Transaction " + confirmed.hash);
    return true;
  });
  const pendingListings = useMemo(() => listings.filter((listing) => listing.settlement === "instant"), [listings]);
  async function execute(listing: Listing, kind: "buy" | "cancel" | "update", price?: bigint) {
    if (!lucid || !address) return;
    let expectedPool: Awaited<ReturnType<typeof readSharedPool>> | undefined;
    await transaction.run(async () => {
      const tools = await import("@lucid-evolution/lucid");
      const orderbook = await reviewedOrderbook(tools);
      const current = (await lucid.utxosByOutRef([listing.utxo]))[0];
      if (!current || current.datum !== listing.utxo.datum) throw new Error("Listing changed or was spent. Refresh the orderbook.");
      const decoded = decodeMarketListing(tools, current);
      const pool = decoded.settlement.kind === "pool" ? await readSharedPool(lucid, tools) : undefined;
      expectedPool = pool;
      const scripts: MarketScripts = pool?.scripts || { orderbook, pool: orderbook, lp: orderbook, inventory: orderbook, orderbookAddress, poolAddress: "" };
      const action = kind === "update" ? { kind, listing: decoded, price: price! } as const : { kind, listing: decoded };
      return buildMarketAction(lucid, tools, scripts, address, action, pool);
    }, async () => {
      if (expectedPool) await assertFreshPool(lucid, await import("@lucid-evolution/lucid"), expectedPool);
      if (!(await lucid.utxosByOutRef([listing.utxo])).length) throw new Error("Listing was spent. Refresh before signing.");
    }, undefined, kind === "cancel" && listing.settlement === "instant" ? "instant sell cancellation" : undefined);
    setEditing(null);
  }
  async function buyListing(listing: Listing) { await execute(listing, "buy"); }
  async function cancelListing(listing: Listing) { await execute(listing, "cancel"); }
  function beginEdit(listing: Listing) { setEditing(listing); setEditPrice(listing.price.toString()); }
  async function updateListing(listing: Listing) {
    try { if (!/^[1-9][0-9]*$/.test(editPrice)) throw new Error("Enter a positive whole price in quote base units."); await execute(listing, "update", BigInt(editPrice)); }
    catch (error) { setMessage({ kind: "error", text: error instanceof Error ? error.message : "Invalid price." }); }
  }

  const renderListing = (listing: Listing) => {
    const owned = listing.managed;
    const purchaseSubmitted = purchasedListingIds.has(listing.id);
    const tokenName = assetDisplayName(unit(listing.rwa), assetNameText(listing.rwa.assetName), assetNames, listing.fraction ? unit(listing.fraction.original) : undefined);
    const originalName = listing.fraction ? assetDisplayName(unit(listing.fraction.original), assetNameText(listing.fraction.original.assetName), assetNames) : "";
    return <article className={"marketplace-listing " + (listingLayout === "card" ? "marketplace-trading-card" : "")} key={listing.id}>
      <div className="marketplace-asset">
        <>{thumbnails[unit(listing.rwa)] ? <Image className="marketplace-thumbnail" src={thumbnails[unit(listing.rwa)]} alt={tokenName + " thumbnail"} width={56} height={56} unoptimized /> : <span className={"marketplace-asset-mark " + (listing.fraction ? "fraction" : "")}>{listing.fraction ? "ƒ" : "RWA"}</span>}</>
        <div>
          <strong>{tokenName} × {listing.quantity.toString()}</strong>
          <code>{listing.rwa.policyId}{listing.rwa.assetName}</code>
          {listing.fraction && <span className="marketplace-fraction-detail">Fraction of {originalName} · total supply {listing.fraction.totalFractions.toString()}</span>}
          {listing.settlement === "direct" && <Link className="marketplace-asset-details-link" href={"/assets?asset=" + unit(listing.fraction?.original ?? listing.rwa)}>View metadata &amp; attestation ↗</Link>}
          <span className={listing.settlement === "pool" ? "marketplace-badge pool" : "marketplace-badge"}>{listing.settlement === "pool" ? "Pool owned" : listing.settlement === "instant" ? "Instant Sell · pending" : "P2P seller"}</span>
        </div>
      </div>
      <div>
        <span className="marketplace-listing-label">Price</span>
        <strong className="marketplace-listing-value">{listing.priceAsset.policyId ? listing.price.toString() : formatAda(listing.price)} <small>{listing.priceAsset.policyId ? assetDisplayName(unit(listing.priceAsset), assetNameText(listing.priceAsset.assetName), assetNames) : "ADA"}</small></strong>
      </div>
      <div className="marketplace-actions">
        {purchaseSubmitted ? <button type="button" className="primary" disabled>Purchase submitted</button> : owned ? <><button type="button" className="primary" disabled title="This wallet created the listing">Your listing</button>{listing.settlement !== "pool" && <><button type="button" onClick={() => beginEdit(listing)} disabled={loading || transaction.busy || Boolean(transaction.hash)}>Edit</button><button type="button" onClick={() => void cancelListing(listing)} disabled={loading || transaction.busy || Boolean(transaction.hash)}>Cancel</button></>}</> : listing.settlement === "instant" ? <span className="marketplace-badge">Awaiting batcher · not publicly purchasable</span> : !lucid || !address ? <button type="button" className="primary" onClick={() => void connect()} disabled={loading || transaction.busy || Boolean(transaction.hash)}>Connect wallet to buy</button> : <button type="button" className="primary" onClick={() => void buyListing(listing)} disabled={loading || transaction.busy || Boolean(transaction.hash)}>Buy</button>}
      </div>
    </article>;
  };

  const renderSection = (title: string, kicker: string, items: Listing[], empty: string) => {
    const isListedTokens = kicker === "P2P orderbook";
    return <section className="marketplace-book">
      <div className="marketplace-book-head"><div><span className="section-kicker">{kicker}</span><h3>{title}</h3></div><div className="marketplace-book-controls">{isListedTokens && <div className="marketplace-layout-toggle" role="group" aria-label="Listed token layout"><button type="button" className={listingLayout === "card" ? "selected" : ""} onClick={() => setListingLayout("card")}>Card view</button><button type="button" className={listingLayout === "list" ? "selected" : ""} onClick={() => setListingLayout("list")}>List view</button></div>}<span className="marketplace-count">{loaded ? items.length + " available" : "Connect to load"}</span></div></div>
      {!orderbookAddress && <p className="marketplace-empty">Set <code>NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS</code> to discover this book.</p>}
      {orderbookAddress && !lucid && <p className="marketplace-empty">Connect Eternl to inspect the orderbook.</p>}
      {orderbookAddress && lucid && loaded && items.length === 0 && <p className="marketplace-empty">{empty}</p>}
      {orderbookAddress && lucid && items.length > 0 && <div className={"marketplace-list " + (isListedTokens && listingLayout === "card" ? "marketplace-card-grid" : "")}>{items.map(renderListing)}</div>}
    </section>;
  };
  return <div className="marketplace-workbench">
    <section className="marketplace-card">
      <div className="section-heading"><div><span className="section-kicker">{ownerOnly ? "Your marketplace activity" : "Orderbook / shared settlement"}</span><h2>{ownerOnly ? "Manage your listings" : "Trade RWA ownership"}</h2></div><span className="step-badge">{orderbookAddress ? "Contract configured" : "Address needed"}</span></div>
      <p className="marketplace-intro">{ownerOnly ? "Update listing prices, cancel open listings and track requests awaiting operator settlement." : "Browse direct P2P listings and pool-owned inventory in one orderbook."}</p>
      <div className="marketplace-toolbar">
        <span className="wallet-assets-note">{ownerOnly ? "Only listings and requests owned by the connected wallet appear here." : "Buy listed assets here."}</span>
        <div className="marketplace-toolbar-actions">{!lucid && <button className="primary-button" type="button" onClick={() => void connect()} disabled={status === "connecting"}>{status === "connecting" ? "Connecting…" : "Connect wallet"}</button>}<button className="marketplace-refresh" type="button" onClick={() => void refresh()} disabled={!lucid || loading} title={!lucid ? "Connect a wallet to refresh the orderbook" : undefined}>{loading ? "Loading…" : "Refresh"}</button></div>
      </div>
      {message && <p className={message.kind === "error" ? "marketplace-message marketplace-error" : "marketplace-message marketplace-success"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      <div className="marketplace-market-summary"><div><span>{ownerOnly ? "Your direct listings" : "Direct listings"}</span><strong>{lucid && loaded && !loading && message?.kind !== "error" ? p2pListings.length : "—"}</strong></div>{!ownerOnly && <div><span>Pool inventory</span><strong>{lucid && loaded && !loading && message?.kind !== "error" ? poolListings.length : "—"}</strong></div>}{ownerOnly && <div><span>Your Instant Sell requests</span><strong>{lucid && loaded && !loading && message?.kind !== "error" ? pendingListings.length : "—"}</strong></div>}</div>
    </section>
    {marketplaceToast && <div className="marketplace-toast" role="status"><strong>Marketplace updated</strong><span>{marketplaceToast}</span><button type="button" onClick={() => setMarketplaceToast(null)} aria-label="Dismiss Marketplace notification">×</button></div>}
    {editing && <div className="marketplace-edit-backdrop" role="presentation" onMouseDown={() => !loading && setEditing(null)}><section className="marketplace-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="marketplace-edit-title" onMouseDown={(event) => event.stopPropagation()}><div className="listing-dialog-heading"><div><span className="section-kicker">Marketplace listing</span><h2 id="marketplace-edit-title">Edit price</h2></div><button type="button" className="listing-dialog-close" onClick={() => setEditing(null)} disabled={loading || transaction.busy || Boolean(transaction.hash)} aria-label="Close edit dialog">×</button></div><p>Update the price for {assetDisplayName(unit(editing.rwa), assetNameText(editing.rwa.assetName), assetNames, editing.fraction ? unit(editing.fraction.original) : undefined)}. The listed quantity remains {editing.quantity.toString()}.</p><label className="field"><span className="field-label">Price in base units</span><input autoFocus inputMode="numeric" pattern="[0-9]+" min="1" value={editPrice} onChange={(event) => setEditPrice(event.target.value)} /></label><div className="marketplace-edit-dialog-actions"><button type="button" onClick={() => setEditing(null)} disabled={loading || transaction.busy || Boolean(transaction.hash)}>Cancel</button><button type="button" className="primary-button" onClick={() => void updateListing(editing)} disabled={loading || transaction.busy || Boolean(transaction.hash)}>{loading ? "Awaiting wallet…" : "Save price"}</button></div></section></div>}
    <MarketTransactionStatus {...transaction} />
    {ownerOnly && <LegacyRequestRecovery />}
    <section className="marketplace-listings">
      {pendingListings.length > 0 && renderSection("Pending Instant Sell", "Seller-owned escrow", pendingListings, "No pending Instant Sell listings.")}
      {renderSection(ownerOnly ? "Your direct listings" : "Listed tokens", "P2P orderbook", p2pListings, ownerOnly ? "You have no open direct listings. Select an asset in Portfolio to create one." : "No direct user listings are currently open.")}
      {!ownerOnly && renderSection("Available tokens", "Shared pool inventory", poolListings, "No pool-owned inventory is currently available.")}
    </section>
  </div>;

}
