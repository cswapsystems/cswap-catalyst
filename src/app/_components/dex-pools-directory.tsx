"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { assetDisplayName, cachedAssetName, loadAssetNames } from "@/lib/asset-display-name";
import { formatAda } from "@/lib/ada";
import { createBrowserChainProvider } from "@/lib/browser-chain-provider";
import { assetUnit, decodePool, displayName, format, formatPoolSpotPrice, isAuthenticatedPool, loadDex, type AssetClass, type Pool } from "@/lib/protocol/dex-client";

function shortUnit(unit: string) { return unit.length > 24 ? `${unit.slice(0, 14)}…${unit.slice(-8)}` : unit; }

export default function DexPoolsDirectory() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [assetNames, setAssetNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const label = useCallback((asset: AssetClass) => {
    if (!asset.policyId) return "ADA";
    const unit = assetUnit(asset);
    return assetDisplayName(unit, displayName(asset), assetNames);
  }, [assetNames]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const tools = await import("@lucid-evolution/lucid");
      const [{ deployment }, lucid] = await Promise.all([
        loadDex(tools),
        tools.Lucid(createBrowserChainProvider(tools), "Preprod", { presetProtocolParameters: tools.PROTOCOL_PARAMETERS_DEFAULT }),
      ]);
      const discovered: Pool[] = [];
      for (const utxo of await lucid.utxosAt(deployment.ammAddress)) {
        try {
          const pool = decodePool(tools, utxo);
          if (isAuthenticatedPool(pool, deployment)) discovered.push(pool);
        } catch { /* Ignore unrelated or malformed outputs at the DEX address. */ }
      }
      setPools(discovered.sort((left, right) => left.id.localeCompare(right.id)));
    } catch (cause) {
      setPools([]);
      setError(cause instanceof Error ? cause.message : "Unable to load active pools.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);

  useEffect(() => {
    const units = [...new Set(pools.flatMap((pool) => [assetUnit(pool.assetA), assetUnit(pool.assetB)]).filter((unit) => unit !== "lovelace"))];
    if (!units.length) { setAssetNames({}); return; }
    let cancelled = false;
    setAssetNames((current) => ({ ...current, ...Object.fromEntries(units.map((unit) => [unit, cachedAssetName(unit)]).filter(([, name]) => Boolean(name))) }));
    void loadAssetNames(units).then((names) => { if (!cancelled) setAssetNames((current) => ({ ...current, ...names })); });
    return () => { cancelled = true; };
  }, [pools]);

  const rows = useMemo(() => pools.map((pool) => {
    const token = label(pool.assetB);
    const quote = label(pool.assetA);
    const nativeQuote = Boolean(pool.assetA.policyId);
    return { pool, token, quote, nativeQuote, price: formatPoolSpotPrice(pool.reserveA, pool.reserveB, !nativeQuote) };
  }), [label, pools]);

  return <section className="dex-pools pools-directory" aria-labelledby="pools-directory-title">
    <div className="dex-pools-head"><div><span className="section-kicker">Live on-chain markets</span><h2 id="pools-directory-title">Available trading pairs</h2><p>Spot prices and liquidity are calculated from current authenticated pool reserves. Execution prices change with trade size, fees, and intervening transactions.</p></div><button type="button" className="refresh-button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    {error && <p className="dex-warning" role="alert">{error}</p>}
    {loading && !rows.length && <p className="dex-empty" role="status">Reading active pools from Cardano Preprod…</p>}
    {!loading && !error && !rows.length && <p className="dex-empty">No authenticated trading pools are currently active.</p>}
    {rows.length > 0 && <div className="pools-list">{rows.map(({ pool, token, quote, nativeQuote, price }) => <article className="pool-directory-row" key={pool.id}>
      <div className="pool-directory-pair"><span className="pool-pair-icon" aria-hidden="true">⇄</span><div><h3>{token} / {quote}</h3><code title={assetUnit(pool.assetB)}>{shortUnit(assetUnit(pool.assetB))}</code></div></div>
      <dl className="pool-directory-metrics">
        <div><dt>Trading price</dt><dd>{price} {nativeQuote ? `${quote} base units` : "ADA"}</dd></div>
        <div><dt>{nativeQuote ? "Liquidity (quote × 2)" : "Liquidity (ADA × 2)"}</dt><dd>{nativeQuote ? format(pool.reserveA * BigInt(2)) + ` ${quote} base units` : formatAda(pool.reserveA * BigInt(2)) + " ADA"}</dd></div>
        <div><dt>{nativeQuote ? `${quote} RESERVE` : "ADA RESERVE"}</dt><dd>{nativeQuote ? format(pool.reserveA) + " base units" : formatAda(pool.reserveA) + " ADA"}</dd></div>
        <div><dt>FRACTION RESERVE</dt><dd>{format(pool.reserveB)} base units</dd></div>
        <div><dt>Swap fee</dt><dd>{(Number(pool.feeD - pool.feeN) / Number(pool.feeD) * 100).toLocaleString("en-US", { maximumFractionDigits: 4 })}%</dd></div>
      </dl>
      <Link className="primary-button pool-directory-trade" href={`/dex?pool=${encodeURIComponent(pool.id)}`}>Trade pair <span className="button-arrow" aria-hidden="true">↗</span></Link>
    </article>)}</div>}
  </section>;
}
