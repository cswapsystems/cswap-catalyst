"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { loadPortfolio, type PositionGroup } from "@/lib/portfolio";
import { formatAda } from "@/lib/ada";
import { useWallet } from "./wallet-context";

export default function PortfolioPositions() {
  const { lucid, address, connect, status } = useWallet();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ owner: string; revision: number; groups: PositionGroup[]; error?: string } | null>(null);
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const current = result?.owner === address && result.revision === revision ? result : null;
  const groups = current?.groups ?? [];
  const loading = Boolean(lucid && address && !current);
  useEffect(() => {
    if (!lucid || !address) return;
    let cancelled = false;
    void loadPortfolio(lucid, address).then((groups) => { if (!cancelled) setResult({ owner: address, revision, groups }); }).catch((cause) => { if (!cancelled) setResult({ owner: address, revision, groups: [], error: cause instanceof Error ? cause.message : "Unable to load positions." }); });
    return () => { cancelled = true; };
  }, [lucid, address, revision]);
  const positions = groups.flatMap((group) => group.positions);
  const escrowAda = positions.reduce((sum, item) => sum + (item.deposit ?? BigInt(0)), BigInt(0));
  return <section className="portfolio-positions">
    <div className="section-heading"><h2>Your open positions</h2><button type="button" className="refresh-button" onClick={() => setRevision((value) => value + 1)} disabled={!lucid || loading}>Refresh positions</button></div>
    {!lucid && <div className="wallet-assets-empty"><p>Connect your wallet to find its escrowed assets and liquidity positions.</p><button type="button" className="primary-button" disabled={status === "connecting"} onClick={() => void connect()}>Connect Eternl</button></div>}
    {loading && <p role="status">Reading vaults, escrow, and liquidity positions…</p>}
    {current?.error && <p role="alert" className="form-message error-message">{current.error}</p>}
    {current && !current.error && <>
      <div className="position-summary"><div><span>Open positions found</span><strong>{positions.length}</strong></div><div><span>ADA in listing / request / offer escrow</span><strong>{formatAda(escrowAda)} ADA</strong></div><div><span>Sources available</span><strong>{groups.filter((group) => !group.error).length} / {groups.length}</strong></div></div>
      <p className="wallet-assets-note">Escrow ADA is not a fee or spendable balance. Refunds depend on cancellation and settlement terms. Vault deposits and LP reserves are excluded from this total. Positions cover configured deployments and the connected payment key. Funded FT bootstrap escrows include both providers&apos; on-chain contributions and remain locked until Team pool creation.</p>
      <div className="position-toolbar"><label className="field"><span>Position type</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option>All</option>{groups.map((group) => <option key={group.name}>{group.name}</option>)}</select></label><label className="field"><span>Search asset ID or position</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
      {groups.filter((group) => filter === "All" || group.name === filter).map((group) => {
        const rows = group.positions.filter((position) => (position.unit + position.detail + position.kind).toLowerCase().includes(search.toLowerCase()));
        return <section className="position-group" key={group.name}><h3>{group.name}</h3>{group.warning && <p role="status" className="registry-action-blocked">{group.warning}</p>}{group.error ? <p role="status" className="registry-action-blocked">Unavailable: {group.error}</p> : rows.length === 0 ? <p className="wallet-assets-note">{search ? "No positions match this search." : "No open positions found for this wallet."}</p> : <ul>{rows.map((position) => <li className="position-card" key={position.id}><div><span className="step-badge">{position.kind}</span><h4>{position.quantity.toLocaleString("en-US")} {position.kind.includes("liquidity") || position.kind === "Shared reserves" ? "LP units" : "units"}</h4><Link href={"/assets?asset=" + position.unit}><code>{position.unit}</code></Link><p>{position.detail}</p>{position.deposit !== undefined && <p>Escrow ADA: {formatAda(position.deposit)}</p>}<a href={"https://preprod.cardanoscan.io/transaction/" + position.id.split("#")[0]} target="_blank" rel="noreferrer">Inspect transaction</a></div><Link className="primary-button" href={position.href}>{position.action}</Link></li>)}</ul>}</section>;
      })}
    </>}
  </section>;
}
