"use client";

import WorkflowLinks from "./workflow-links";
import { useCallback, useEffect, useMemo, useState } from "react";
import PlatformHeader from "./platform-header";
import TeamWorkbench from "./team-workbench";
import { marketplaceDeployment } from "@/lib/protocol/marketplace-deployment";
import { formatAda } from "@/lib/ada";
import { useWallet } from "./wallet-context";

type PoolHealth = { cash: bigint; minimumReserve: bigint; inventoryValue: bigint; totalLpSupply: bigint; paused: boolean };

function datumBool(tools: typeof import("@lucid-evolution/lucid"), value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (!(value instanceof tools.Constr) || value.fields.length !== 0 || (value.index !== 0 && value.index !== 1)) throw new Error("The configured shared pool paused flag is invalid.");
  return value.index === 1;
}


export default function TeamConsole() {
  const { address, lucid, connect, status: walletStatus } = useWallet();
  const [health, setHealth] = useState<PoolHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!lucid) { setHealth(null); return; }
    setLoading(true);
    setError("");
    try {
      const tools = await import("@lucid-evolution/lucid");
      const utxo = await lucid.utxoByUnit(marketplaceDeployment.pool.token);
      if (!utxo.datum) throw new Error("The configured shared pool has no inline datum.");
      const datum = tools.Data.from(utxo.datum);
      if (!(datum instanceof tools.Constr) || datum.index !== 0 || datum.fields.length !== 10 || typeof datum.fields[6] !== "bigint" || typeof datum.fields[7] !== "bigint" || typeof datum.fields[9] !== "bigint") throw new Error("The configured shared pool datum is invalid.");
      setHealth({ cash: utxo.assets.lovelace ?? BigInt(0), totalLpSupply: datum.fields[6], minimumReserve: datum.fields[7], paused: datumBool(tools, datum.fields[8]), inventoryValue: datum.fields[9] });
    } catch (cause) {
      setHealth(null);
      setError(cause instanceof Error ? cause.message : "Unable to read shared-pool health.");
    } finally {
      setLoading(false);
    }
  }, [lucid]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const available = useMemo(() => health ? health.cash - health.minimumReserve : BigInt(0), [health]);
  const status = !address ? "Wallet not connected" : loading ? "Checking pool…" : health?.paused ? "Pool paused" : health ? "Pool live" : "Pool unavailable";

  return <div className="platform-shell">
    <PlatformHeader />
    <main id="main-content" tabIndex={-1} className="page-main">
      <section className="hero team-hero"><div><span className="eyebrow">Operations</span><h1>Operator console</h1><p>Review sale requests and settlement capacity. Signing actions require the corresponding authorized wallet.</p></div><span className={health && !health.paused ? "network-badge" : "step-badge"}>{status}</span></section>
      <WorkflowLinks label="Operator workflows" items={[
        { href: "/team/inventory", title: "Prices & inventory", description: "Publish bids, resale prices and acquisition limits." },
        { href: "/registry", title: "Asset approvals", description: "Review admission requests and approved assets." },
        { href: "/team/dex", title: "DEX controls", description: "Review pool launches and administer the factory." },
      ]} />
      {!lucid && <div className="team-connect-callout"><strong>Connect an operator wallet</strong><span>Connect Eternl to load settlement capacity and review pending requests. Each action checks its required signer.</span><button type="button" className="primary-button" disabled={walletStatus === "connecting"} onClick={() => void connect()}>{walletStatus === "connecting" ? "Connecting…" : "Connect Eternl"}</button></div>}
      <div className="team-console">
        <section className="team-overview">
          <div className="section-heading"><div><span className="section-kicker">Live settlement health</span><h2>Shared pool capacity</h2></div><button type="button" className="refresh-button" onClick={() => void refresh()} disabled={!lucid || loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
          <p className="mint-intro">Available cash excludes the protected reserve. Liquidity changes are also blocked while pool-owned inventory is still open.</p>
          <div className="team-metrics">
            <dl><dt>Pool cash</dt><dd>{health ? formatAda(health.cash) + " tADA" : "-"}</dd></dl>
            <dl><dt>Available for bids</dt><dd>{health ? formatAda(available > BigInt(0) ? available : BigInt(0)) + " tADA" : "-"}</dd></dl>
            <dl><dt>Protected reserve</dt><dd>{health ? formatAda(health.minimumReserve) + " tADA" : "-"}</dd></dl>
            <dl><dt>Open inventory value</dt><dd>{health ? formatAda(health.inventoryValue) + " tADA" : "-"}</dd></dl>
            <dl><dt>LP supply</dt><dd>{health ? health.totalLpSupply.toString() : "-"}</dd></dl>
          </div>
          {error && <p role="alert" className="form-message error-message">{error}</p>}
        </section>
        <section className="team-pricing">
          <div className="section-heading"><div><span className="section-kicker">Pricing and acquisition</span><h2>Instant-sell queue</h2></div><span className="marketplace-count">Batcher-only signing</span></div>
          <p className="mint-intro">Use the published operator price book to approve acquisitions. The application rechecks active status, quantity limits, registry admission and available cash before signing. These operational checks are not new on-chain guarantees.</p>
          <TeamWorkbench onSettled={refresh} />
        </section>
      </div>
    </main>
  </div>;
}
