"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { formatWalletAda, summarizeWalletAssets, type WalletAsset, type WalletHoldings } from "@/lib/wallet-assets";
import { assetDisplayName, cachedAssetName, loadAssetNames, rememberAssetName } from "@/lib/asset-display-name";
import { marketplaceDeployment } from "@/lib/protocol/marketplace-deployment";
import dexDeployment from "../../../dex-deployment.preprod.json";
import PortfolioSale from "./portfolio-sale";
import WorkflowLinks from "./workflow-links";
import FractionalizeForm from "./fractionalize-form";
import PlatformHeader from "./platform-header";
import { useWallet } from "./wallet-context";

type LoadResult = { owner: string; wallet: LucidEvolution; revision: number; holdings: WalletHoldings | null; error: string };
type AssetAttachment = { label: string; href: string };
type AssetPreview = { image: string | null; description: string; facts: { label: string; value: string }[]; attachments: AssetAttachment[] };
type DataConstr = { index: number; fields: unknown[] };
type FractionVaultLink = { originalUnit: string; totalFractions: bigint; vaultAddress: string };
type FractionAsset = { asset: WalletAsset; link: FractionVaultLink };
type FractionalizeAction = { mode: "split" | "combine"; originalUnit: string; assetName: string };

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

function asConstr(value: unknown): DataConstr {
  if (typeof value !== "object" || value === null || !("index" in value) || !("fields" in value)) throw new Error("Malformed vault datum.");
  const candidate = value as { index: unknown; fields: unknown };
  if (typeof candidate.index !== "number" || !Array.isArray(candidate.fields)) throw new Error("Malformed vault datum.");
  return { index: candidate.index, fields: candidate.fields };
}

async function loadFractionVaultLinks(lucid: LucidEvolution): Promise<Map<string, FractionVaultLink>> {
  const response = await fetch("/api/fractionalize-blueprint", { cache: "no-store" });
  const blueprint = await response.json() as { vaultCompiledCode?: string; error?: string };
  if (!response.ok || !blueprint.vaultCompiledCode) throw new Error(blueprint.error ?? "Fractionalization validator unavailable.");
  const tools = await import("@lucid-evolution/lucid");
  const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "mainnet" ? "Mainnet" as const : "Preprod" as const;
  const vaultAddress = tools.validatorToAddress(network, { type: "PlutusV3", script: blueprint.vaultCompiledCode });
  const links = new Map<string, FractionVaultLink>();
  for (const utxo of await lucid.utxosAt(vaultAddress)) {
    if (!utxo.datum) continue;
    try {
      const root = asConstr(tools.Data.from(utxo.datum));
      if (root.index !== 0 || root.fields.length !== 8 || typeof root.fields[2] !== "string" || typeof root.fields[3] !== "string" || typeof root.fields[4] !== "string" || typeof root.fields[5] !== "string" || typeof root.fields[6] !== "bigint") continue;
      links.set(root.fields[4] + root.fields[5], { originalUnit: root.fields[2] + root.fields[3], totalFractions: root.fields[6], vaultAddress });
    } catch {
      // Ignore unrelated or legacy outputs at the vault address.
    }
  }
  return links;
}

function formatTokenQuantity(quantity: bigint): string { return new Intl.NumberFormat("en-US").format(quantity); }

function WalletAssetRow({ asset, preview, fractionLink, onList, onFractionalize, onCombine }: { asset: WalletAsset; preview?: AssetPreview; fractionLink?: FractionVaultLink; onList: (asset: WalletAsset) => void; onFractionalize?: (asset: WalletAsset) => void; onCombine: (asset: WalletAsset, link: FractionVaultLink) => void }) {
  const canCombine = Boolean(fractionLink && asset.quantity === fractionLink.totalFractions);
  return <li className="wallet-asset-row">
    <div className="wallet-asset-thumbnail">{preview?.image ? <Image src={preview.image} alt="" width={72} height={72} unoptimized /> : <span aria-hidden="true">RWA</span>}</div>
    <div className="wallet-asset-info">
      <h3>{asset.name}</h3>
      <span>Policy ID</span>
      <code>{asset.policyId}</code>
      <span>Asset name (hex)</span>
      <code>{asset.nameHex || "Empty asset name"}</code>
      {fractionLink && <div className="wallet-fraction-origin">
        <span>Linked through active vault</span>
        <Link href={"/assets?asset=" + encodeURIComponent(fractionLink.originalUnit)}>View original asset ↗</Link>
        <small>{formatTokenQuantity(fractionLink.totalFractions)} total fractions · vault <code title={fractionLink.vaultAddress}>{fractionLink.vaultAddress.slice(0, 16)}…{fractionLink.vaultAddress.slice(-10)}</code></small>
      </div>}
      {preview?.description && <p className="wallet-asset-description">{preview.description}</p>}
      {preview?.facts.length ? <dl className="wallet-asset-facts">{preview.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl> : null}
      {preview?.attachments.length ? <div className="wallet-asset-attachments"><span>Attachments</span>{preview.attachments.map((attachment) => <a key={attachment.href} href={attachment.href} target="_blank" rel="noreferrer">{attachment.label} ↗</a>)}</div> : null}
    </div>
    <div className="wallet-asset-quantity"><span>Quantity · base units</span><strong>{formatTokenQuantity(asset.quantity)}</strong></div>
    <div className="wallet-asset-actions">
      <Link className="wallet-asset-inspect" href={"/assets?asset=" + asset.unit} aria-label={"Inspect " + asset.name}>Inspect asset ↗</Link>
      {fractionLink ? <>
        <button className="text-button" type="button" disabled={!canCombine} onClick={() => onCombine(asset, fractionLink)}>Combine</button>
        <span className={"wallet-combine-threshold" + (canCombine ? " ready" : "")}>{canCombine ? "Vault threshold met — ready to combine" : formatTokenQuantity(asset.quantity) + " of " + formatTokenQuantity(fractionLink.totalFractions) + " fractions required"}</span>
      </> : onFractionalize ? <button className="text-button" type="button" onClick={() => onFractionalize(asset)}>Fractionalize</button> : null}
      <button className="text-button" type="button" onClick={() => onList(asset)}>Sell / List</button>
    </div>
  </li>;
}

export default function WalletAssets() {
  const { lucid, address, status, error: connectionError, connect } = useWallet();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [search, setSearch] = useState("");
  const [listingAsset, setListingAsset] = useState<WalletAsset | null>(null);
  const [fractionalizeAction, setFractionalizeAction] = useState<FractionalizeAction | null>(null);
  const [assetPreviews, setAssetPreviews] = useState<Record<string, AssetPreview>>({});
  const [assetNames, setAssetNames] = useState<Record<string, string>>({});
  const [fractionLinks, setFractionLinks] = useState<Map<string, FractionVaultLink>>(() => new Map());
  const [fractionLinkStatus, setFractionLinkStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const connected = status === "connected" && Boolean(address && lucid);
  const current = connected && result?.owner === address && result.wallet === lucid && result.revision === revision ? result : null;
  const loading = connected && !current;
  const holdings = current?.holdings;
  const namedAssets = useMemo(() => holdings?.assets.map((asset) => ({
    ...asset,
    name: assetDisplayName(asset.unit, asset.name, assetNames, fractionLinks.get(asset.unit)?.originalUnit),
  })) ?? [], [assetNames, fractionLinks, holdings]);
  const visibleAssets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return namedAssets.filter((asset) => !query || asset.name.toLowerCase().includes(query) || asset.unit.includes(query));
  }, [namedAssets, search]);
  const groupedAssets = useMemo(() => {
    const originals: WalletAsset[] = [];
    const fractions: FractionAsset[] = [];
    const reserves: WalletAsset[] = [], dex: WalletAsset[] = [];
    for (const asset of visibleAssets) {
      const link = fractionLinks.get(asset.unit);
      if (asset.unit === marketplaceDeployment.pool.lpToken) { reserves.push(asset); continue; }
      if (asset.policyId === dexDeployment.lpPolicyId) { dex.push(asset); continue; }
      if (link) fractions.push({ asset, link });
      else originals.push(asset);
    }
    return { originals, fractions, reserves, dex };
  }, [fractionLinks, visibleAssets]);
  const assetCounts = useMemo(() => {
    const assets = holdings?.assets ?? [];
    const fractions = assets.filter((asset) => fractionLinks.has(asset.unit)).length;
    return { originals: assets.filter((asset) => !fractionLinks.has(asset.unit) && asset.unit !== marketplaceDeployment.pool.lpToken && asset.policyId !== dexDeployment.lpPolicyId).length, fractions };
  }, [fractionLinks, holdings]);

  useEffect(() => {
    if (!lucid || !address || status !== "connected") {
      setFractionLinks(new Map());
      setFractionLinkStatus("idle");
      return;
    }
    let cancelled = false;
    setFractionLinkStatus("loading");
    void loadFractionVaultLinks(lucid).then((links) => {
      if (!cancelled) {
        setFractionLinks(links);
        setFractionLinkStatus("ready");
      }
    }).catch(() => {
      if (!cancelled) {
        setFractionLinks(new Map());
        setFractionLinkStatus("error");
      }
    });
    return () => { cancelled = true; };
  }, [address, lucid, revision, status]);


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
    if (units.length === 0) { setAssetPreviews({}); setAssetNames({}); return; }
    setAssetNames((current) => ({ ...current, ...Object.fromEntries(units.map((unit) => [unit, cachedAssetName(unit)]).filter(([, name]) => Boolean(name))) }));
    void Promise.all(units.map(async (assetUnit) => {
      try {
        const response = await fetch("/api/blockfrost/assets/" + encodeURIComponent(assetUnit), { cache: "force-cache" });
        if (!response.ok) return null;
        const asset = await response.json() as { onchain_metadata?: unknown };
        return [assetUnit, previewMetadata(asset.onchain_metadata), rememberAssetName(assetUnit, asset.onchain_metadata)] as const;
      } catch { return null; }
    })).then((results) => {
      if (!cancelled) {
        setAssetPreviews(Object.fromEntries(results.filter((result): result is readonly [string, AssetPreview, string] => result !== null).map(([unit, preview]) => [unit, preview])));
        setAssetNames((current) => ({ ...current, ...Object.fromEntries(results.filter((result): result is readonly [string, AssetPreview, string] => result !== null && Boolean(result[2])).map(([unit, , name]) => [unit, name])) }));
      }
    });
    return () => { cancelled = true; };
  }, [holdings]);

  useEffect(() => {
    const originalUnits = [...new Set([...fractionLinks.values()].map((link) => link.originalUnit))];
    if (!originalUnits.length) return;
    let cancelled = false;
    void loadAssetNames(originalUnits).then((names) => { if (!cancelled) setAssetNames((current) => ({ ...current, ...names })); });
    return () => { cancelled = true; };
  }, [fractionLinks]);

  function openListing(asset: WalletAsset) { setListingAsset(asset); }

  function openFractionalize(asset: WalletAsset) {
    if (fractionLinkStatus !== "ready" || fractionLinks.has(asset.unit)) return;
    setFractionalizeAction({ mode: "split", originalUnit: asset.unit, assetName: asset.name });
  }

  function openCombine(asset: WalletAsset, link: FractionVaultLink) {
    if (asset.quantity !== link.totalFractions) return;
    setFractionalizeAction({ mode: "combine", originalUnit: link.originalUnit, assetName: asset.name });
  }

  useEffect(() => {
    if (fractionalizeAction?.mode === "split" && fractionLinks.has(fractionalizeAction.originalUnit)) setFractionalizeAction(null);
  }, [fractionLinks, fractionalizeAction]);

  return <div className="platform-shell"><PlatformHeader /><main id="main-content" tabIndex={-1} className="page-main">
    <section className="hero"><div><span className="eyebrow">Portfolio</span><h1>Your holdings</h1><p>View your wallet assets. Select an asset to sell, list, split or combine its ownership.</p></div></section>
    <WorkflowLinks label="Portfolio workflows" className="portfolio-workflows" items={[
      { href: "/portfolio/positions", title: "Open positions", description: "Find assets in escrow, vaults and liquidity pools." },
      { href: "/portfolio/orders", title: "Listings & requests", description: "Edit listings or cancel pending Instant Sell requests." },
      { href: "/portfolio/asset-requests", title: "Asset support", description: "Request Team review and manage your asset support requests." },
      { href: "/portfolio/reserves", title: "Shared liquidity", description: "Manage your share of the Instant Sell settlement pool." },
    ]} />
    <section className="wallet-assets-board" aria-labelledby="wallet-assets-title">
      <div className="section-heading"><div><span className="section-kicker">Wallet holdings</span><h2 id="wallet-assets-title">Your ADA and tokens</h2></div>{connected && <button className="primary-button" type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? "Loading…" : "Refresh assets"}</button>}</div>
      {!connected && <div className="wallet-assets-empty"><h3>{status === "connecting" ? "Connecting to Eternl…" : "Connect your wallet to see its assets"}</h3><p>This page reads your wallet holdings. No transaction signature is requested.</p><button className="primary-button" type="button" disabled={status === "connecting"} onClick={() => void connect()}>{status === "connecting" ? "Connecting…" : "Connect Eternl"}</button>{connectionError && <p role="alert" className="form-message error-message">{connectionError}</p>}</div>}
      {connected && <p className="wallet-assets-address"><strong>Connected address</strong><code>{address}</code></p>}
      {loading && <p className="wallet-assets-empty" role="status">Reading assets from Eternl…</p>}
      {current?.error && <p className="form-message error-message" role="alert">{current.error}</p>}
      {holdings && <>
        <dl className="wallet-assets-summary">
          <div><dt>ADA in wallet</dt><dd>{formatWalletAda(holdings.lovelace)} <span>ADA</span></dd><Link href="/dex">Swap</Link> · <Link href="/portfolio/reserves">Add to reserves</Link></div>
          <div><dt>RWA & other native tokens</dt><dd>{assetCounts.originals.toLocaleString("en-US")}</dd></div>
          <div><dt>Reserves LP tokens</dt><dd>{(holdings.assets.find((asset) => asset.unit === marketplaceDeployment.pool.lpToken)?.quantity || BigInt(0)).toString()}</dd></div>
          <div><dt>DEX LP positions</dt><dd>{holdings.assets.filter((asset) => asset.policyId === dexDeployment.lpPolicyId).length}</dd></div>
          <div><dt>Fraction positions</dt><dd>{fractionLinkStatus === "ready" ? assetCounts.fractions.toLocaleString("en-US") : "Unverified"}</dd></div>
        </dl>
        <p className="wallet-assets-note">Balances come from the wallet’s unspent outputs. Staking rewards and assets locked in vaults or marketplace listings are not included. Fraction positions are matched to active fractionalization vaults; token quantities are shown in base units.</p>
        {holdings.assets.length > 0 && <label className="field wallet-assets-search"><span className="field-label">Search your tokens</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Asset name, policy ID, or full asset ID" /></label>}
        {holdings.assets.length === 0 ? <div className="wallet-assets-empty"><h3>{holdings.utxoCount === 0 ? "This wallet has no unspent outputs" : "No native tokens in this wallet"}</h3><p>Tokens received or minted into this wallet will appear here after the wallet updates. Use Refresh assets to check again.</p></div> : visibleAssets.length === 0 ? <p className="wallet-assets-empty">No assets match your search.</p> : <>
          <p className="wallet-assets-count" role="status">Showing {visibleAssets.length.toLocaleString("en-US")} of {holdings.assets.length.toLocaleString("en-US")} assets</p>
          {fractionLinkStatus === "loading" && <p role="status" className="wallet-assets-note">Matching fraction tokens to active vaults. Wallet and LP balances remain visible.</p>}
          {fractionLinkStatus === "error" && <p className="wallet-assets-vault-error" role="status">Vault links are temporarily unavailable. Fractionalize is disabled until the links can be verified. Refresh assets to retry.</p>}
          <div className="wallet-assets-groups">
            {([["Reserves LP", groupedAssets.reserves, "/portfolio/reserves"], ["DEX LP", groupedAssets.dex, "/dex/liquidity"]] as const).map(([title, assets, href]) => <section className="wallet-assets-group" key={title}><div className="wallet-assets-group-heading"><h3>{title}</h3><span>{assets.length}</span></div>{assets.length ? <ul className="wallet-assets-list">{assets.map((asset) => <li className="position-card" key={asset.unit}><div><h4>{asset.name}</h4><code>{asset.unit}</code><p>{asset.quantity.toString()} LP base units</p></div><Link className="primary-button" href={href}>Manage liquidity</Link></li>)}</ul> : <p className="wallet-assets-empty">No matching LP tokens in this wallet.</p>}</section>)}
            <section className="wallet-assets-group" aria-labelledby="original-assets-title">
              <div className="wallet-assets-group-heading"><div><span className="section-kicker">Direct holdings</span><h3 id="original-assets-title">RWA & other native tokens</h3><p>RWA tokens and other native assets, excluding known fractions and protocol LP tokens. Metadata is descriptive, not proof of backing.</p></div><span>{groupedAssets.originals.length.toLocaleString("en-US")}</span></div>
              {groupedAssets.originals.length ? <ul className="wallet-assets-list">{groupedAssets.originals.map((asset) => <WalletAssetRow key={asset.unit} asset={asset} preview={assetPreviews[asset.unit]} onList={openListing} onFractionalize={fractionLinkStatus === "ready" && asset.quantity === BigInt(1) ? openFractionalize : undefined} onCombine={openCombine} />)}</ul> : <p className="wallet-assets-empty wallet-assets-list-empty">No RWA or other native tokens match your search.</p>}
            </section>
            <section className="wallet-assets-group" aria-labelledby="fraction-assets-title">
              <div className="wallet-assets-group-heading"><div><span className="section-kicker">Vault-linked holdings</span><h3 id="fraction-assets-title">Fractions</h3><p>Fraction tokens held in this wallet, with their original asset preserved through the vault.</p></div><span>{groupedAssets.fractions.length.toLocaleString("en-US")}</span></div>
              {groupedAssets.fractions.length ? <ul className="wallet-assets-list">{groupedAssets.fractions.map(({ asset, link }) => <WalletAssetRow key={asset.unit} asset={asset} preview={assetPreviews[asset.unit]} fractionLink={link} onList={openListing} onCombine={openCombine} />)}</ul> : <p className="wallet-assets-empty wallet-assets-list-empty">{fractionLinkStatus === "ready" ? "No fractional positions match your search." : "Fraction classification is not yet verified."}</p>}
            </section>
          </div>
        </>}
      </>}

    </section>
    {fractionalizeAction && <div className="listing-dialog-backdrop" role="presentation" onMouseDown={() => setFractionalizeAction(null)}><section className="asset-action-dialog" role="dialog" aria-modal="true" aria-label={(fractionalizeAction.mode === "split" ? "Fractionalize asset: " : "Combine fractions: ") + fractionalizeAction.assetName} onMouseDown={(event) => event.stopPropagation()}><button type="button" className="listing-dialog-close asset-action-dialog-close" onClick={() => setFractionalizeAction(null)} aria-label="Close asset action">×</button><FractionalizeForm key={fractionalizeAction.mode + fractionalizeAction.originalUnit} initialMode={fractionalizeAction.mode} initialAssetUnit={fractionalizeAction.originalUnit} /></section></div>}
    {listingAsset && <PortfolioSale key={listingAsset.unit} asset={listingAsset} onClose={() => setListingAsset(null)} onConfirmed={() => setRevision((value) => value + 1)} />}
  </main></div>;
}
