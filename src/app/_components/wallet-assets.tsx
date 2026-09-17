"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { formatWalletAda, summarizeWalletAssets, type WalletAsset, type WalletHoldings } from "@/lib/wallet-assets";
import { marketplaceOrderbookAddress } from "@/lib/protocol/marketplace-deployment";
import PlatformHeader from "./platform-header";
import { useWallet } from "./wallet-context";

type LoadResult = { owner: string; wallet: LucidEvolution; revision: number; holdings: WalletHoldings | null; error: string };
type AssetAttachment = { label: string; href: string };
type AssetPreview = { image: string | null; description: string; facts: { label: string; value: string }[]; attachments: AssetAttachment[] };

function metadataText(value: unknown): string {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string").join("") : typeof value === "string" ? value : "";
}
function ipfsGatewayUrl(value: unknown): string | null {
  const uri = metadataText(value);
  const cid = uri.startsWith("ipfs://") ? uri.slice(7).split("/")[0] : "";
  return /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(cid) ? "/api/ipfs/gateway/" + cid : null;
}
function attachmentUrl(value: unknown): string | null {
  const uri = metadataText(value);
  return ipfsGatewayUrl(uri) ?? (uri.startsWith("https://") ? uri : null);
}
function previewMetadata(value: unknown): AssetPreview {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const factFields: { label: string; raw: unknown }[] = [{ label: "Category", raw: metadata.rwaCategory }, { label: "Property type", raw: metadata.propertyType }, { label: "Location", raw: metadata.publicLocation }, { label: "Valuation", raw: metadata.valuation }];
  const facts = factFields.flatMap(({ label, raw }) => { const text = metadataText(raw); return text ? [{ label, value: text }] : []; });
  const attachments = Array.isArray(metadata.files) ? metadata.files.flatMap((file) => {
    const entry = file && typeof file === "object" && !Array.isArray(file) ? file as Record<string, unknown> : {};
    const href = attachmentUrl(entry.src);
    return href ? [{ label: metadataText(entry.name) || "Attachment", href }] : [];
  }) : [];
  return { image: ipfsGatewayUrl(metadata.image), description: metadataText(metadata.description), facts, attachments };
}

function addressData(tools: typeof import("@lucid-evolution/lucid"), address: string) {
  const details = tools.getAddressDetails(address);
  if (!details?.paymentCredential) throw new Error("The proceeds address is not a supported Cardano address.");
  const payment = details.paymentCredential.type === "Key" ? { PubKeyCredential: [details.paymentCredential.hash] } : { ScriptCredential: [details.paymentCredential.hash] };
  const staking = details.stakeCredential ? { StakingHash: [details.stakeCredential.type === "Key" ? { PubKeyCredential: [details.stakeCredential.hash] } : { ScriptCredential: [details.stakeCredential.hash] }] } : null;
  return tools.Data.from(tools.Data.to({ addressCredential: payment, addressStakingCredential: staking } as never, tools.AddressSchema as never));
}

export default function WalletAssets() {
  const { lucid, address, status, error: connectionError, connect } = useWallet();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [search, setSearch] = useState("");
  const [listingAsset, setListingAsset] = useState<WalletAsset | null>(null);
  const [listingPrice, setListingPrice] = useState("");
  const [listingPaymentUnit, setListingPaymentUnit] = useState("lovelace");
  const [listingPaymentPolicyId, setListingPaymentPolicyId] = useState("");
  const [listingPaymentAssetName, setListingPaymentAssetName] = useState("");
  const [listingProceeds, setListingProceeds] = useState("");
  const [listingMessage, setListingMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [listingSubmitting, setListingSubmitting] = useState(false);
  const [assetPreviews, setAssetPreviews] = useState<Record<string, AssetPreview>>({});
  const connected = status === "connected" && Boolean(address && lucid);
  const current = connected && result?.owner === address && result.wallet === lucid && result.revision === revision ? result : null;
  const loading = connected && !current;
  const holdings = current?.holdings;
  const visibleAssets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return holdings?.assets.filter((asset) => !query || asset.name.toLowerCase().includes(query) || asset.unit.includes(query)) ?? [];
  }, [holdings, search]);
  const paymentAssets = useMemo(() => holdings?.assets.filter((asset) => asset.unit !== listingAsset?.unit) ?? [], [holdings, listingAsset]);

  useEffect(() => {
    if (!lucid || !address || status !== "connected") return;
    let cancelled = false;
    async function load(wallet: LucidEvolution) {
      try {
        if (await wallet.wallet().address() !== address) throw new Error("Your wallet account changed. Disconnect and reconnect to load the current account.");
        const utxos = await wallet.wallet().getUtxos();
        if (await wallet.wallet().address() !== address) throw new Error("Your wallet account changed while loading. Disconnect and reconnect.");
        if (!cancelled) setResult({ owner: address, wallet, revision, holdings: summarizeWalletAssets(utxos), error: "" });
      } catch (cause) {
        if (!cancelled) setResult({ owner: address, wallet, revision, holdings: null, error: cause instanceof Error ? cause.message : "Unable to read wallet assets. Try refreshing." });
      }
    }
    void load(lucid);
    return () => { cancelled = true; };
  }, [address, lucid, revision, status]);

  useEffect(() => {
    let cancelled = false;
    const units = holdings?.assets.map((asset) => asset.unit) ?? [];
    if (units.length === 0) { setAssetPreviews({}); return; }
    void Promise.all(units.map(async (assetUnit) => {
      try {
        const response = await fetch("/api/blockfrost/assets/" + encodeURIComponent(assetUnit), { cache: "force-cache" });
        if (!response.ok) return null;
        const asset = await response.json() as { onchain_metadata?: unknown };
        return [assetUnit, previewMetadata(asset.onchain_metadata)] as const;
      } catch { return null; }
    })).then((results) => {
      if (!cancelled) setAssetPreviews(Object.fromEntries(results.filter((result): result is readonly [string, AssetPreview] => result !== null)));
    });
    return () => { cancelled = true; };
  }, [holdings]);

  function openListing(asset: WalletAsset) {
    setListingAsset(asset);
    setListingPrice("");
    setListingPaymentUnit("lovelace");
    setListingPaymentPolicyId("");
    setListingPaymentAssetName("");
    setListingProceeds(address ?? "");
    setListingMessage(null);
  }

  function closeListing() {
    if (listingSubmitting) return;
    setListingAsset(null);
    setListingMessage(null);
  }

  async function submitListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setListingMessage(null);
    if (!listingAsset || !lucid || !address) return setListingMessage({ kind: "error", text: "Connect Eternl before creating a listing." });
    if (!marketplaceOrderbookAddress) return setListingMessage({ kind: "error", text: "The Marketplace orderbook address is not configured." });
    try {
      const price = BigInt(listingPrice);
      if (price <= BigInt(0)) throw new Error("Price must be greater than zero.");
      const tools = await import("@lucid-evolution/lucid");
      const paymentAsset = listingPaymentUnit === "lovelace"
        ? { policyId: "", assetName: "" }
        : listingPaymentUnit === "custom"
          ? { policyId: listingPaymentPolicyId.trim().toLowerCase(), assetName: listingPaymentAssetName.trim().toLowerCase() }
          : (() => {
              const asset = paymentAssets.find((candidate) => candidate.unit === listingPaymentUnit);
              if (!asset) throw new Error("Select a valid payment asset.");
              return { policyId: asset.policyId, assetName: asset.nameHex };
            })();
      if (paymentAsset.policyId && (!/[0-9a-f]{56}/.test(paymentAsset.policyId) || !/[0-9a-f]*/.test(paymentAsset.assetName) || paymentAsset.assetName.length % 2 !== 0)) throw new Error("Payment asset must use a 56-character policy ID and an even-length hexadecimal asset name.");
      if (paymentAsset.policyId === listingAsset.policyId && paymentAsset.assetName === listingAsset.nameHex) throw new Error("The requested payment asset cannot be the listed NFT.");
      const owner = tools.getAddressDetails(address);
      if (!owner?.paymentCredential || owner.paymentCredential.type !== "Key") throw new Error("The connected wallet needs a payment-key address.");
      const proceeds = listingProceeds.trim() || address;
      const datum = new tools.Constr(0, [
        addressData(tools, proceeds),
        owner.paymentCredential.hash,
        new tools.Constr(0, []),
        new tools.Constr(0, [listingAsset.policyId, listingAsset.nameHex]),
        BigInt(1),
        new tools.Constr(0, [paymentAsset.policyId, paymentAsset.assetName]),
        price,
      ]);
      setListingSubmitting(true);
      const tx = await lucid.newTx()
        .pay.ToContract(marketplaceOrderbookAddress, { kind: "inline", value: tools.Data.to(datum as import("@lucid-evolution/lucid").Data) }, { lovelace: BigInt(2_000_000), [listingAsset.unit]: BigInt(1) })
        .complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      setListingMessage({ kind: "success", text: `Listing submitted: ${hash}. It will appear in the Marketplace after confirmation.` });
      setRevision((value) => value + 1);
    } catch (cause) {
      setListingMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Listing creation was cancelled or failed." });
    } finally {
      setListingSubmitting(false);
    }
  }

  return <div className="platform-shell"><PlatformHeader /><main className="page-main">
    <section className="hero"><div><span className="eyebrow">Connected wallet · Preprod</span><h1>My assets</h1><p>See the ADA and native tokens held in your connected wallet. Inspect an asset to view its metadata and registry approval.</p></div></section>
    <section className="wallet-assets-board" aria-labelledby="wallet-assets-title">
      <div className="section-heading"><div><span className="section-kicker">Wallet holdings</span><h2 id="wallet-assets-title">Your ADA and tokens</h2></div>{connected && <button className="primary-button" type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? "Loading…" : "Refresh assets"}</button>}</div>
      {!connected && <div className="wallet-assets-empty"><h3>{status === "connecting" ? "Connecting to Eternl…" : "Connect your wallet to see its assets"}</h3><p>This page reads your wallet holdings. No transaction signature is requested.</p><button className="primary-button" type="button" disabled={status === "connecting"} onClick={() => void connect()}>{status === "connecting" ? "Connecting…" : "Connect Eternl"}</button>{connectionError && <p role="alert" className="form-message error-message">{connectionError}</p>}</div>}
      {connected && <p className="wallet-assets-address"><strong>Connected address</strong><code>{address}</code></p>}
      {loading && <p className="wallet-assets-empty" role="status">Reading assets from Eternl…</p>}
      {current?.error && <p className="form-message error-message" role="alert">{current.error}</p>}
      {holdings && <>
        <dl className="wallet-assets-summary"><div><dt>ADA in wallet</dt><dd>{formatWalletAda(holdings.lovelace)} <span>ADA</span></dd></div><div><dt>Distinct native assets</dt><dd>{holdings.assets.length.toLocaleString("en-US")}</dd></div></dl>
        <p className="wallet-assets-note">Balances come from the wallet’s unspent outputs. Staking rewards and assets locked in vaults or marketplace listings are not included. Token quantities are shown in base units; a balance of one does not by itself identify an NFT.</p>
        {holdings.assets.length > 0 && <label className="field wallet-assets-search"><span className="field-label">Search your tokens</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Asset name, policy ID, or full asset ID" /></label>}
        {holdings.assets.length === 0 ? <div className="wallet-assets-empty"><h3>{holdings.utxoCount === 0 ? "This wallet has no unspent outputs" : "No native tokens in this wallet"}</h3><p>Tokens received or minted into this wallet will appear here after the wallet updates. Use Refresh assets to check again.</p></div> : visibleAssets.length === 0 ? <p className="wallet-assets-empty">No assets match your search.</p> : <>
          <p className="wallet-assets-count" role="status">Showing {visibleAssets.length.toLocaleString("en-US")} of {holdings.assets.length.toLocaleString("en-US")} assets</p>
          <ul className="wallet-assets-list">{visibleAssets.map((asset) => {
            const preview = assetPreviews[asset.unit];
            return <li className="wallet-asset-row" key={asset.unit}>
              <div className="wallet-asset-thumbnail">{preview?.image ? <Image src={preview.image} alt="" width={72} height={72} unoptimized /> : <span aria-hidden="true">RWA</span>}</div>
              <div className="wallet-asset-info"><h3>{asset.name}</h3><span>Policy ID</span><code>{asset.policyId}</code><span>Asset name (hex)</span><code>{asset.nameHex || "Empty asset name"}</code>{preview?.description && <p className="wallet-asset-description">{preview.description}</p>}{preview?.facts.length ? <dl className="wallet-asset-facts">{preview.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl> : null}{preview?.attachments.length ? <div className="wallet-asset-attachments"><span>Attachments</span>{preview.attachments.map((attachment) => <a key={attachment.href} href={attachment.href} target="_blank" rel="noreferrer">{attachment.label} ↗</a>)}</div> : null}</div>
              <div className="wallet-asset-quantity"><span>Quantity · base units</span><strong>{new Intl.NumberFormat("en-US").format(asset.quantity)}</strong></div>
              <div className="wallet-asset-actions"><Link className="wallet-asset-inspect" href={"/assets?asset=" + asset.unit} aria-label={"Inspect " + asset.name}>Inspect asset ↗</Link>{asset.quantity === BigInt(1) && <button className="text-button" type="button" onClick={() => openListing(asset)}>List</button>}</div>
            </li>;
          })}</ul>
        </>}
      </>}
    </section>
    {listingAsset && <div className="listing-dialog-backdrop" role="presentation" onMouseDown={closeListing}><section className="listing-dialog" role="dialog" aria-modal="true" aria-labelledby="listing-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="listing-dialog-heading"><div><span className="section-kicker">Marketplace listing</span><h2 id="listing-dialog-title">List {listingAsset.name}</h2></div><button type="button" className="listing-dialog-close" onClick={closeListing} disabled={listingSubmitting} aria-label="Close listing dialog">×</button></div>
      <p>Set the requested payment asset and price for this one-unit NFT. The NFT and 2 ADA escrow deposit will move to the Marketplace contract when you approve the transaction in Eternl.</p>
      <form className="wallet-listing-form" onSubmit={submitListing}>
        <label className="field"><span className="field-label">Requested payment asset</span><select value={listingPaymentUnit} onChange={(event) => setListingPaymentUnit(event.target.value)}><option value="lovelace">ADA</option>{paymentAssets.map((asset) => <option key={asset.unit} value={asset.unit}>{asset.name} · {asset.policyId.slice(0, 10)}…</option>)}<option value="custom">Custom native asset (for example, USDCx)</option></select></label>
        {listingPaymentUnit === "custom" && <div className="field-grid"><label className="field"><span className="field-label">Payment policy ID</span><input required value={listingPaymentPolicyId} onChange={(event) => setListingPaymentPolicyId(event.target.value)} placeholder="56-character policy ID" /></label><label className="field"><span className="field-label">Payment asset name (hex)</span><input value={listingPaymentAssetName} onChange={(event) => setListingPaymentAssetName(event.target.value)} placeholder="Hex asset name; may be empty" /></label></div>}
        <label className="field"><span className="field-label">Price in base units</span><input required inputMode="numeric" pattern="[0-9]+" min="1" value={listingPrice} onChange={(event) => setListingPrice(event.target.value)} placeholder="e.g. 100000" autoFocus /></label>
        <label className="field"><span className="field-label">Proceeds address</span><input value={listingProceeds} onChange={(event) => setListingProceeds(event.target.value)} placeholder="Defaults to connected wallet" /></label>
        <p className="wallet-assets-note">Use the asset’s smallest units. ADA uses lovelace (1 ADA = 1,000,000 lovelace). Buyers pay the requested asset; the 2 ADA escrow deposit returns to you when the listing sells or is cancelled.</p>
        {listingMessage && <p className={listingMessage.kind === "error" ? "form-message error-message" : "form-message success-message"} role={listingMessage.kind === "error" ? "alert" : "status"}>{listingMessage.text}</p>}
        <div className="listing-dialog-actions"><button type="button" onClick={closeListing} disabled={listingSubmitting}>Cancel</button><button type="submit" className="primary-button" disabled={listingSubmitting}>{listingSubmitting ? "Awaiting Eternl…" : "Create listing"}</button></div>
      </form>
    </section></div>}
  </main></div>;
}
