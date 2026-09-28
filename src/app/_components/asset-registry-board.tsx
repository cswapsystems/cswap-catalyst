"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PlatformHeader from "./platform-header";
import { formatAda } from "@/lib/ada";
import { MAX_REGISTRY_ENTRIES, readRegistry, readRegistryRequests, registryConfigured, registryReader, type RegistryRequestState, type RegistryState } from "@/lib/asset-registry";

type RegistryContents = {
  registry: RegistryState;
  requests: RegistryRequestState;
};

export default function AssetRegistryBoard() {
  const [contents, setContents] = useState<RegistryContents | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!registryConfigured) {
      setContents(null);
      return;
    }

    setReading(true);
    setError("");
    try {
      const registry = await readRegistry();
      const requests = await readRegistryRequests(await registryReader(), registry);
      setContents({ registry, requests });
    } catch (cause) {
      setContents(null);
      setError(cause instanceof Error ? cause.message : "The asset registry could not be read.");
    } finally {
      setReading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const approved = contents?.registry.entries ?? [];
  const pending = contents?.requests.requests ?? [];

  return <div className="platform-shell">
    <PlatformHeader />
    <main id="main-content" tabIndex={-1} className="page-main">
      <section className="hero">
        <div>
          <span className="eyebrow">Shared pool marketplace · Preprod</span>
          <h1>Asset Registry</h1>
          <p>Read the on-chain issuer approval record and review outstanding requests for new asset support. Shared-pool Instant Sell also requires a posted on-chain price and available reserves.</p>
        </div>
      </section>

      <section className="asset-registry-overview">
        <div className="asset-registry-overview-head">
          <div>
            <span className="section-kicker">Authenticated on-chain state</span>
            <h2>Shared-pool asset support</h2>
          </div>
          <button type="button" className="refresh-button" disabled={reading} onClick={() => void refresh()}>{reading ? "Refreshing…" : "↻ Refresh"}</button>
        </div>
        <p>A pending request is an intake record, not approval to trade. Registry approval is separate from the shared pool&apos;s on-chain price entries.</p>
        <div className="asset-registry-counts" aria-label="Registry totals">
          <dl><dt>Issuer-approved assets</dt><dd>{approved.length}</dd><p>of {MAX_REGISTRY_ENTRIES} capacity</p></dl>
          <dl><dt>Pending support requests</dt><dd>{pending.length}</dd><p>waiting for Team review</p></dl>
          <dl><dt>Registry revision</dt><dd>{contents ? contents.registry.version.toString() : "—"}</dd><p>increments on each approval change</p></dl>
        </div>
        {contents && <details className="asset-registry-identity"><summary>Registry details</summary><dl><div><dt>Registry address</dt><dd><code>{contents.registry.address}</code></dd></div><div><dt>Registry identity token</dt><dd><code>{contents.registry.token}</code></dd></div></dl></details>}
        {!registryConfigured && <p role="alert" className="asset-registry-error">The shared-pool registry has not been configured for this deployment.</p>}
        {reading && !contents && <p role="status" className="asset-registry-loading">Reading the authenticated registry and request UTxOs…</p>}
        {error && <p role="alert" className="asset-registry-error">{error}</p>}
      </section>

      {contents && <div className="asset-registry-columns">
        <section className="asset-registry-list-card">
          <div className="asset-registry-list-head">
            <div><span className="section-kicker">Live allowlist</span><h2>Approved assets</h2></div>
            <span>{approved.length}</span>
          </div>
          <p>These exact asset units have issuer approval. Approval alone does not enable Instant Sell.</p>
          {approved.length === 0
            ? <div className="asset-registry-empty"><strong>No approved assets yet</strong><p>When the Team approves an asset request, it will appear here after the registry transaction confirms.</p></div>
            : <ul className="asset-registry-units">{approved.map((unit) => <li key={unit}><div><span>Original asset unit</span><code>{unit}</code></div><Link href={"/assets?asset=" + unit}>View asset <span aria-hidden="true">→</span></Link></li>)}</ul>}
        </section>

        <section className="asset-registry-list-card">
          <div className="asset-registry-list-head">
            <div><span className="section-kicker">Permissionless intake</span><h2>Pending support requests</h2></div>
            <span>{pending.length}</span>
          </div>
          <p>These request UTxOs are awaiting a Team approval or rejection. They do not make an asset tradable.</p>
          {pending.length === 0
            ? <div className="asset-registry-empty"><strong>No pending requests</strong><p>New requests submitted from Portfolio → Asset support will appear here while they await Team review.</p></div>
            : <ul className="asset-registry-requests">{pending.map((request) => <li key={request.id}><div className="asset-registry-request-head"><div><span>Request UTxO</span><code>{request.id}</code></div><small>{request.assets.length} asset{request.assets.length === 1 ? "" : "s"}</small></div><dl><dt>Requester</dt><dd><code>{request.requester}</code></dd><dt>Refundable deposit</dt><dd>{formatAda(request.lockedLovelace)} ADA</dd></dl><ul>{request.assets.map((unit) => <li key={unit}><Link href={"/assets?asset=" + unit}><code>{unit}</code></Link></li>)}</ul></li>)}</ul>}
        </section>
      </div>}

      <section className="asset-registry-actions">
        <div><span className="section-kicker">Registry workflow</span><h2>Want to request asset support?</h2><p>Asset owners can request review and cancel their own pending requests from Portfolio. The configured issuer handles approvals in Operations.</p></div>
        <Link className="primary-button" href="/portfolio/asset-requests">Manage my requests <span aria-hidden="true">→</span></Link>
      </section>
    </main>
  </div>;
}
