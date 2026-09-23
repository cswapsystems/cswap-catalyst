"use client";

import { useCallback, useEffect, useState } from "react";
import { formatWalletAda, summarizeWalletAssets } from "@/lib/wallet-assets";
import PlatformHeader from "./platform-header";
import { useWallet } from "./wallet-context";

type WalletSnapshot = {
  paymentKeyHash: string;
  lovelace: bigint;
  utxoCount: number;
};

export default function WalletWorkbench() {
  const { address, lucid, status, error: connectionError, connect } = useWallet();
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!lucid || !address || status !== "connected") {
      setSnapshot(null);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const tools = await import("@lucid-evolution/lucid");
      const credential = tools.getAddressDetails(address).paymentCredential;
      if (credential?.type !== "Key") throw new Error("This connected address does not have a payment public-key credential.");
      const holdings = summarizeWalletAssets(await lucid.wallet().getUtxos());
      setSnapshot({ paymentKeyHash: credential.hash, lovelace: holdings.lovelace, utxoCount: holdings.utxoCount });
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "Unable to read the connected wallet.");
    } finally {
      setLoading(false);
    }
  }, [address, lucid, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const connected = status === "connected" && Boolean(address && lucid);

  return <div className="platform-shell">
    <PlatformHeader />
    <main id="main-content" tabIndex={-1} className="page-main">
      <section className="hero">
        <div>
          <span className="eyebrow">Connected wallet · Preprod</span>
          <h1>My wallet</h1>
          <p>Inspect the public payment key hash and the ADA total exposed by your connected Eternl wallet. This page does not request a transaction signature.</p>
        </div>
      </section>

      <section className="my-wallet-board">
        <div className="my-wallet-head">
          <div><span className="section-kicker">Public wallet details</span><h2>Connected account</h2></div>
          {connected && <button type="button" className="refresh-button" disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "↻ Refresh"}</button>}
        </div>

        {!connected && <div className="my-wallet-empty">
          <span aria-hidden="true">⌁</span>
          <h3>Connect Eternl to view this wallet</h3>
          <p>CSWAP reads the public account address and wallet UTxOs supplied by Eternl. It does not request a transaction signature.</p>
          <button type="button" className="primary-button" onClick={() => void connect()} disabled={status === "connecting"}>{status === "connecting" ? "Connecting…" : "Connect Eternl"}</button>
          {connectionError && <p role="alert">{connectionError}</p>}
        </div>}

        {connected && error && <p role="alert" className="my-wallet-error">{error}</p>}
        {connected && loading && !snapshot && <p role="status" className="my-wallet-loading">Reading the connected wallet…</p>}
        {connected && snapshot && <>
          <dl className="my-wallet-summary">
            <div><dt>Total ADA</dt><dd>{formatWalletAda(snapshot.lovelace)} <span>₳</span></dd><p>{snapshot.lovelace.toString()} lovelace across {snapshot.utxoCount} UTxO{snapshot.utxoCount === 1 ? "" : "s"}</p></div>
            <div><dt>Payment public-key hash</dt><dd><code>{snapshot.paymentKeyHash}</code></dd><p>This key hash is used by validators that require this wallet’s payment-key signature.</p></div>
          </dl>
          <div className="my-wallet-address"><span>Connected address</span><code>{address}</code></div>
        </>}
      </section>
    </main>
  </div>;
}
