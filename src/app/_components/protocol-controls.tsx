"use client";

import { buildMarketAction } from "@/lib/marketplace";
import { confirmTransaction } from "@/lib/transaction-confirmation";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet-context";
import { readSharedPool } from "@/lib/protocol/shared-pool-client";
import { asConstr, loadDex } from "@/lib/protocol/dex-client";
import { factoryPauseFields, parseProtectedReserve } from "@/lib/operator-controls";
import { assertWalletSession, isWalletChangedError } from "@/lib/wallet-guard";

type Snapshot = { owner: string; admin: string; paused: boolean; reserve: string; nativeQuote: boolean; ref: string };

export default function ProtocolControls({ protocol, onConfirmed }: { protocol: "shared" | "dex"; onConfirmed?: () => void }) {
  const { lucid, address, disconnect } = useWallet();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [reserve, setReserve] = useState("");
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [hash, setHash] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const current = snapshot?.owner === address ? snapshot : null;

  const refresh = useCallback(async () => {
    setBusy(true); setError(""); setSnapshot(null); setAuthorized(false);
    try {
      if (!lucid || !address) return;
      setSessionError("");
      const tools = await import("@lucid-evolution/lucid");
      let next: Snapshot;
      if (protocol === "shared") {
        const pool = await readSharedPool(lucid, tools);
        next = { owner: address, admin: pool.admin, paused: pool.paused, reserve: pool.quote.policyId ? pool.minimum.toString() : (pool.minimum / BigInt(1_000_000)).toString() + "." + (pool.minimum % BigInt(1_000_000)).toString().padStart(6, "0"), nativeQuote: Boolean(pool.quote.policyId), ref: `${pool.utxo.txHash}#${pool.utxo.outputIndex}` };
      } else {
        const { deployment, scripts } = await loadDex(tools);
        if (!scripts.factoryState) throw new Error("Factory controls require the reviewed factory migration.");
        const state = await lucid.utxoByUnit(deployment.factoryToken);
        if (!state.datum || state.address !== deployment.factoryAddress) throw new Error("Factory state is unavailable.");
        const raw = asConstr(tools.Data.from(state.datum), "factory");
        if (raw.fields.length !== 5 || raw.fields[1] !== deployment.admin) throw new Error("Factory identity mismatch.");
        next = { owner: address, admin: deployment.admin, paused: asConstr(raw.fields[4], "pause").index === 1, reserve: "", nativeQuote: false, ref: `${state.txHash}#${state.outputIndex}` };
      }
      const key = tools.getAddressDetails(address).paymentCredential;
      setAuthorized(key?.type === "Key" && key.hash === next.admin);
      setSnapshot(next); setPaused(next.paused); setReserve(next.reserve);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load controls."); }
    finally { setBusy(false); }
  }, [address, lucid, protocol]);

  useEffect(() => { const timer = setTimeout(() => void refresh(), 0); return () => clearTimeout(timer); }, [refresh]);

  async function submit() {
    if (!lucid || !current || !authorized || (hash && !confirmed)) return;
    setBusy(true); setError("");
    try {
      await assertWalletSession(lucid, address);
      const tools = await import("@lucid-evolution/lucid");
      const key = tools.getAddressDetails(await lucid.wallet().address()).paymentCredential;
      if (key?.type !== "Key" || key.hash !== current.admin) throw new Error("Connect the configured administrator.");
      let builder;
      if (protocol === "shared") {
        const pool = await readSharedPool(lucid, tools);
        if (`${pool.utxo.txHash}#${pool.utxo.outputIndex}` !== current.ref) throw new Error("Pool state changed. Refresh and review before signing.");
        const minimum = parseProtectedReserve(reserve, Boolean(pool.quote.policyId));
        builder = buildMarketAction(lucid, tools, pool.scripts, address, { kind: "configure", minimum, paused }, pool);
      } else {
        const { deployment, scripts } = await loadDex(tools);
        if (!scripts.factoryState) throw new Error("Factory migration is required.");
        const state = await lucid.utxoByUnit(deployment.factoryToken);
        if (!state.datum || `${state.txHash}#${state.outputIndex}` !== current.ref) throw new Error("Factory state changed. Refresh and review before signing.");
        const raw = asConstr(tools.Data.from(state.datum), "factory");
        const flag = new tools.Constr(paused ? 1 : 0, []);
        const next = new tools.Constr(0, factoryPauseFields(raw.fields, flag));
        builder = lucid.newTx().collectFrom([state], tools.Data.to(new tools.Constr(2, [flag]))).attach.SpendingValidator(scripts.factoryState).pay.ToContract(deployment.factoryAddress, { kind: "inline", value: tools.Data.to(next) }, { ...state.assets }).addSigner(address);
      }
      const completed = await builder.complete();
      await assertWalletSession(lucid, address);
      const submitted = await (await completed.sign.withWallet().complete()).submit();
      setHash(submitted); setConfirmed(false);
      const settled = await confirmTransaction(lucid, submitted);
      if (!settled) throw new Error("Submitted, but confirmation is not available yet. Check the transaction before retrying.");
      setConfirmed(true); onConfirmed?.(); await refresh();
    } catch (cause) {
      if (isWalletChangedError(cause)) { setSnapshot(null); setAuthorized(false); setSessionError(cause.message); disconnect(); return; }
      setError(cause instanceof Error ? cause.message : "Control update failed.");
    }
    finally { setBusy(false); }
  }

  async function check() {
    setBusy(true); setError("");
    try { const response = await fetch(`/api/blockfrost/txs/${hash}`, { cache: "no-store" }); if (!response.ok) throw new Error("Confirmation is not yet available."); setConfirmed(true); onConfirmed?.(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to check confirmation."); }
    finally { setBusy(false); }
  }

  return <section className="work-card operator-controls"><div className="section-heading"><h2>{protocol === "shared" ? "Shared-pool configuration" : "Factory pause control"}</h2><button type="button" className="refresh-button" onClick={() => void refresh()} disabled={busy}>Refresh state</button></div>
    {!address && <p>Connect a wallet to inspect protocol controls.</p>}
    {current && <><p>Current state: <strong>{current.paused ? "Paused" : "Live"}</strong>{protocol === "shared" && ` · Protected reserve: ${current.nativeQuote ? current.reserve + " base units" : current.reserve + " ADA"}`}</p><details><summary>Administrator and state reference</summary><code>{current.admin}</code><code>{current.ref}</code></details>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}><fieldset className="module-fieldset" disabled={busy || !authorized || Boolean(hash && !confirmed)}>
        <label className="field"><span>Desired state</span><select value={paused ? "paused" : "live"} onChange={(event) => setPaused(event.target.value === "paused")}><option value="live">Live</option><option value="paused">Paused</option></select></label>
        {protocol === "shared" && <label className="field"><span>Protected reserve ({current.nativeQuote ? "quote base units" : "ADA"})</span><input required inputMode="decimal" value={reserve} onChange={(event) => setReserve(event.target.value)} />{!current.nativeQuote && <span className="field-hint">Minimum 2 ADA so the pool output stays above the Cardano minimum UTxO.</span>}</label>}
        <p>{protocol === "shared" ? "Pause blocks trading and deposits; cash-only withdrawals, top-ups and price updates remain available. Direct listings are separate. The contract enforces the reserve floor; there are no quantity caps, so review exposure before signing acquisitions." : "Pausing the factory prevents creation and normal AMM transitions, including liquidity changes. Review pending activity before pausing."}</p>
        <button type="submit" className="primary-button">{busy ? "Working…" : "Sign configuration update"}</button>
      </fieldset></form>{!authorized && <p className="registry-action-blocked">Only the administrator shown above can sign changes.</p>}</>}
    {hash && <p role="status">{confirmed ? "Confirmed" : "Submitted; awaiting confirmation"}: <a href={`https://preprod.cardanoscan.io/transaction/${hash}`} target="_blank" rel="noreferrer">View transaction</a>{!confirmed && <button type="button" onClick={() => void check()} disabled={busy}>Check confirmation</button>}</p>}
    {sessionError && <p className="form-message error-message" role="alert">{sessionError}</p>}
    {error && <p className="form-message error-message" role="alert">{error}</p>}
  </section>;
}
