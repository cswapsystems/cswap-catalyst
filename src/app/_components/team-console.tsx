"use client";

import WorkflowLinks from "./workflow-links";
import { useCallback, useEffect, useMemo, useState } from "react";
import PlatformHeader from "./platform-header";
import TeamWorkbench from "./team-workbench";
import { readSharedPool } from "@/lib/protocol/shared-pool-client";
import type { SharedPool } from "@/lib/marketplace";
import { formatAda } from "@/lib/ada";
import { useWallet } from "./wallet-context";

export default function TeamConsole() {
  const { address, lucid, connect, status: walletStatus } = useWallet();
  const [health, setHealth] = useState<SharedPool | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!lucid) { setHealth(null); return; }
    setLoading(true);
    setError("");
    try {
      const tools = await import("@lucid-evolution/lucid");
      setHealth(await readSharedPool(lucid, tools));
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

  const available = useMemo(() => health ? health.cash - health.minimum : BigInt(0), [health]);
  const status = !address ? "Wallet not connected" : loading ? "Checking pool…" : health?.closing ? "Pool closing" : health?.paused ? "Pool paused" : health ? "Pool live" : "Pool unavailable";

  const amount = (value: bigint) => health?.quote.policyId ? `${value} quote base units` : `${formatAda(value)} tADA`;
  return <div className="platform-shell">
    <PlatformHeader />
    <main id="main-content" tabIndex={-1} className="page-main">
      <section className="hero team-hero"><div><span className="eyebrow">Operations</span><h1>Operator console</h1><p>Review sale requests and settlement capacity. Signing actions require the corresponding authorized wallet.</p></div><span className={health && !health.paused ? "network-badge" : "step-badge"}>{status}</span></section>
      <WorkflowLinks label="Operator workflows" items={[
        { href: "/team/inventory", title: "Prices & inventory", description: "Publish on-chain bids and resale prices." },
        { href: "/registry", title: "Asset approvals", description: "Review admission requests and approved assets." },
        { href: "/team/dex", title: "DEX controls", description: "Review pool launches and administer the factory." },
      ]} />
      {!lucid && <div className="team-connect-callout"><strong>Connect an operator wallet</strong><span>Connect Eternl to load settlement capacity and review pending requests. Each action checks its required signer.</span><button type="button" className="primary-button" disabled={walletStatus === "connecting"} onClick={() => void connect()}>{walletStatus === "connecting" ? "Connecting…" : "Connect Eternl"}</button></div>}
      <div className="team-console">
        <section className="team-overview">
          <div className="section-heading"><div><span className="section-kicker">Live settlement health</span><h2>Shared pool capacity</h2></div><button type="button" className="refresh-button" onClick={() => void refresh()} disabled={!lucid || loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
          <p className="mint-intro">Available cash excludes the protected reserve. Partial withdrawals pay cash only, even with open inventory. Deposits use cash plus inventory acquisition cost.</p>
          <div className="team-metrics">
            <dl><dt>Pool cash</dt><dd>{health ? amount(health.cash) : "-"}</dd></dl>
            <dl><dt>Available for bids</dt><dd>{health ? amount(available > BigInt(0) ? available : BigInt(0)) : "-"}</dd></dl>
            <dl><dt>Protected reserve</dt><dd>{health ? amount(health.minimum) : "-"}</dd></dl>
            <dl><dt>Open inventory value</dt><dd>{health ? amount(health.inventory) : "-"}</dd></dl>
            <dl><dt>Inventory acquisition cost</dt><dd>{health ? amount(health.cost) : "-"}</dd></dl>
            <dl><dt>Inventory listings</dt><dd>{health ? health.count.toString() : "-"}</dd></dl>
            <dl><dt>LP supply</dt><dd>{health ? health.supply.toString() : "-"}</dd></dl>
          </div>
          {error && <p role="alert" className="form-message error-message">{error}</p>}
        </section>
        <section className="team-pricing">
          <div className="section-heading"><div><span className="section-kicker">Pricing and acquisition</span><h2>Instant-sell queue</h2></div><span className="marketplace-count">Batcher-only signing</span></div>
          <p className="mint-intro">On-chain prices determine acquisition bids and resale asks; the contract enforces the reserve floor. Review the request size and inventory exposure before signing, as there are no quantity caps.</p>
          <TeamWorkbench onSettled={refresh} />
        </section>
      </div>
    </main>
  </div>;
}
