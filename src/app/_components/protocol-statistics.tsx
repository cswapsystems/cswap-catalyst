"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readRegistry } from "@/lib/asset-registry";
import { asConstr, decodePool, isAuthenticatedPool, loadDex } from "@/lib/protocol/dex-client";
import { decodeMarketListing, marketUnit } from "@/lib/marketplace";
import { reviewedOrderbook, readSharedPool } from "@/lib/protocol/shared-pool-client";
import { scanOutputs } from "@/lib/safe-scan";
import { formatAda } from "@/lib/ada";
import { createBrowserChainProvider } from "@/lib/browser-chain-provider";

type Section = { name: string; metrics?: { label: string; value: string }[]; error?: string; note?: string };
export default function ProtocolStatistics() {
  const [sections, setSections] = useState<Section[]>([]);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const tools = await import("@lucid-evolution/lucid");
      // Read-only instance: protocol parameters are not used for UTxO queries.
      // Avoid making every independent statistic depend on a parameters request.
      const lucid = await tools.Lucid(createBrowserChainProvider(tools), "Preprod", { presetProtocolParameters: tools.PROTOCOL_PARAMETERS_DEFAULT });
      const sources: { name: string; read: () => Promise<Omit<Section, "name"> > }[] = [
        { name: "Marketplace", read: async () => {
          const script = await reviewedOrderbook(tools);
          const result = scanOutputs(await lucid.utxosAt(tools.validatorToAddress("Preprod", script)), (utxo) => {
            if (!utxo.datum) return null;
            const listing = decodeMarketListing(tools, utxo);
            return { unit: marketUnit(listing.rwa), pool: listing.settlement.kind === "pool", instant: listing.settlement.kind === "instant" };
          });
          return { metrics: [{ label: "Listed assets · distinct IDs", value: String(new Set(result.items.map((item) => item.unit)).size) }, { label: "Buyable listings", value: String(result.items.filter((item) => !item.instant).length) }, { label: "Pending Instant Sell", value: String(result.items.filter((item) => item.instant).length) }, { label: "Pool-owned listings", value: String(result.items.filter((item) => item.pool).length) }], note: `${result.skipped} unreadable outputs skipped. Listings are not registry endorsements.` };
        } },
        { name: "Asset registry", read: async () => { const registry = await readRegistry(lucid); return { metrics: [{ label: "Registered assets", value: String(registry.entries.length) }, { label: "Registry version", value: registry.version.toString() }] }; } },
        { name: "Shared reserves", read: async () => {
          const pool = await readSharedPool(lucid, tools);
          const amount = (value: bigint) => pool.quote.policyId ? value.toString() + " quote base units" : formatAda(value) + " ADA";
          return { metrics: [{ label: "Pool cash", value: amount(pool.cash) }, { label: "Protected reserve", value: amount(pool.minimum) }, { label: "Available cash", value: amount(pool.cash > pool.minimum ? pool.cash - pool.minimum : BigInt(0)) }, { label: "Inventory ask value", value: amount(pool.inventory) }, { label: "Inventory acquisition cost", value: amount(pool.cost) }, { label: "Inventory listings", value: pool.count.toString() }, { label: "On-chain priced assets", value: String(pool.prices.length) }, { label: "Reserves LP supply · base units", value: pool.supply.toString() }, { label: "Pool status", value: pool.closing ? "Closing" : pool.paused ? "Paused" : "Active" }], note: "Inventory ask value is an operator-set resale value, not cash or an independently appraised valuation." };
        } },
        { name: "DEX", read: async () => {
          const { deployment } = await loadDex(tools);
          const result = scanOutputs(await lucid.utxosAt(deployment.ammAddress), (utxo) => { if (!utxo.datum) return null; const pool = decodePool(tools, utxo); return isAuthenticatedPool(pool, deployment) ? pool : null; });
          const ada = result.items.reduce((sum, pool) => sum + (!pool.assetA.policyId ? pool.reserveA : !pool.assetB.policyId ? pool.reserveB : BigInt(0)), BigInt(0));
          return { metrics: [{ label: "Authenticated DEX pools", value: String(result.items.length) }, { label: "ADA trading reserves", value: formatAda(ada) }], note: `${result.skipped} unreadable outputs skipped. Native token reserves are not converted to ADA or USD.` };
        } },
        { name: "Fractionalization", read: async () => {
          const response = await fetch("/api/fractionalize-blueprint", { cache: "no-store" }); const blueprint = await response.json();
          if (!response.ok || !blueprint.vaultCompiledCode) throw new Error("Vault deployment unavailable.");
          const address = tools.validatorToAddress("Preprod", { type: "PlutusV3", script: blueprint.vaultCompiledCode });
          const result = scanOutputs(await lucid.utxosAt(address), (utxo) => {
            if (!utxo.datum) return null; const root = asConstr(tools.Data.from(utxo.datum), "vault");
            if (root.index !== 0 || root.fields.length !== 8 || typeof root.fields[2] !== "string" || typeof root.fields[3] !== "string" || typeof root.fields[6] !== "bigint") return null;
            return utxo.assets[root.fields[2] + root.fields[3]] === BigInt(1) ? utxo : null;
          });
          return { metrics: [{ label: "Open asset vaults", value: String(result.items.length) }], note: `${result.skipped} unreadable outputs skipped.` };
        } },
      ];
      const results = await Promise.allSettled(sources.map((source) => source.read()));
      setSections(results.map((result, index) => result.status === "fulfilled" ? { name: sources[index].name, ...result.value } : { name: sources[index].name, error: result.reason instanceof Error ? result.reason.message : "Source unavailable." }));
      setUpdated(new Date().toLocaleString());
    } catch { setError("Protocol statistics could not be loaded. Check the chain provider configuration and retry."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <section className="protocol-statistics"><div className="section-heading"><h2>Protocol statistics</h2><button className="refresh-button" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Reading chain…" : "Refresh statistics"}</button></div><p className="wallet-assets-note">{updated ? "Last completed read: " + updated + ". " : ""}Counts cover current unspent outputs, not all-time activity. Sources are read independently and are not a single-block snapshot.</p>{error && <p role="alert">{error}</p>}{sections.map((section) => <section className="work-card" key={section.name}><h3>{section.name}</h3>{section.error ? <p role="status">Unavailable: {section.error}</p> : <><dl className="team-metrics">{section.metrics?.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>{section.note && <p className="wallet-assets-note">{section.note}</p>}</>}</section>)}<div className="portfolio-links"><Link href="/marketplace">Browse listings</Link><Link href="/asset-registry">View registry</Link><Link href="/vault">Explore vaults</Link></div></section>;
}
