"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { formatWalletAda, summarizeWalletAssets, type WalletHoldings } from "@/lib/wallet-assets";
import PlatformHeader from "./platform-header";
import { useWallet } from "./wallet-context";

type LoadResult = { owner: string; wallet: LucidEvolution; revision: number; holdings: WalletHoldings | null; error: string };

export default function WalletAssets() {
  const { lucid, address, status, error: connectionError, connect } = useWallet();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [search, setSearch] = useState("");
  const connected = status === "connected" && Boolean(address && lucid);
  const current = connected && result?.owner === address && result.wallet === lucid && result.revision === revision ? result : null;
  const loading = connected && !current;
  const holdings = current?.holdings;
  const visibleAssets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return holdings?.assets.filter((asset) => !query || asset.name.toLowerCase().includes(query) || asset.unit.includes(query)) ?? [];
  }, [holdings, search]);

  useEffect(() => {
    if (!lucid || !address || status !== "connected") return;
    let cancelled = false;
    async function load(wallet: LucidEvolution) {
      try {
        if (await wallet.wallet().address() !== address) throw new Error("Your wallet account changed. Disconnect and reconnect to load the current account.");
        // Read the wallet's complete UTxO set, including its other receiving
        // addresses, instead of querying only the displayed change address.
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
          <ul className="wallet-assets-list">{visibleAssets.map((asset) => <li className="wallet-asset-row" key={asset.unit}>
            <div className="wallet-asset-info"><h3>{asset.name}</h3><span>Policy ID</span><code>{asset.policyId}</code><span>Asset name (hex)</span><code>{asset.nameHex || "Empty asset name"}</code></div>
            <div className="wallet-asset-quantity"><span>Quantity · base units</span><strong>{new Intl.NumberFormat("en-US").format(asset.quantity)}</strong></div>
            <div className="wallet-asset-actions"><Link className="wallet-asset-inspect" href={"/assets?asset=" + asset.unit} aria-label={"Inspect " + asset.name}>Inspect asset ↗</Link>{asset.quantity === BigInt(1) && <Link className="text-button" href={"/marketplace?asset=" + asset.unit}>List</Link>}</div>
          </li>)}</ul>
        </>}
      </>}
    </section>
  </main></div>;
}
