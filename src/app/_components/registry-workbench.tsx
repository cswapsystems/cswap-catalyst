"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import PlatformHeader from "./platform-header";
import RegistryGuide from "./registry-guide";
import { useWallet } from "./wallet-context";
import { assetData, checkRegistryNetwork, MAX_REGISTRY_ENTRIES, normalizeUnit, readRegistry, readRegistryRequests, registryBlueprint, registryConfigured, registryDatum, registryIssuer, registryReader, registryRequestDatum, REGISTRY_REQUEST_DEPOSIT, registryRequestScript, registryScript, registryToken, verifyOriginalMint, type RegistryRequest, type RegistryRequestState, type RegistryState } from "@/lib/asset-registry";

export default function RegistryWorkbench() {
  const { lucid, address, status: walletStatus } = useWallet();
  const [state, setState] = useState<RegistryState | null>(null);
  const [asset, setAsset] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState("");
  const [pending, setPending] = useState(false);
  const [deployment, setDeployment] = useState<{ token: string; issuer: string; address: string } | null>(null);
  const [isIssuer, setIsIssuer] = useState(false);
  const [walletKey, setWalletKey] = useState("");
  const [requestAssets, setRequestAssets] = useState("");
  const [requestState, setRequestState] = useState<RegistryRequestState | null>(null);
  const hasConfiguration = Boolean(registryToken || registryIssuer);

  const refresh = useCallback(async () => {
    if (!registryConfigured) return;
    setReading(true);
    setError("");
    try {
      const current = await readRegistry();
      setState(current);
      setRequestState(await readRegistryRequests(await registryReader(), current));
    }
    catch (cause) { setState(null); setRequestState(null); setError(cause instanceof Error ? cause.message : "Registry could not be read."); }
    finally { setReading(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void import("@lucid-evolution/lucid").then((tools) => {
      const credential = address ? tools.getAddressDetails(address).paymentCredential : undefined;
      if (!cancelled) {
        setWalletKey(credential?.type === "Key" ? credential.hash : "");
        setIsIssuer(walletStatus === "connected" && credential?.type === "Key" && credential.hash === registryIssuer);
      }
    });
    return () => { cancelled = true; };
  }, [address, walletStatus]);

  async function signingWallet(): Promise<LucidEvolution> {
    checkRegistryNetwork();
    if (!lucid || !address || walletStatus !== "connected" || !window.cardano?.eternl) throw new Error("Connect Eternl on Preprod first.");
    const api = await window.cardano.eternl.enable();
    if (await api.getNetworkId() !== 0) throw new Error("Switch Eternl to Preprod.");
    lucid.selectWallet.fromAPI(api);
    if (await lucid.wallet().address() !== address) throw new Error("Wallet account changed. Reconnect before continuing.");
    return lucid;
  }

  async function confirmed(wallet: LucidEvolution, hash: string) {
    setTxHash(hash);
    setPending(true);
    setMessage("Transaction submitted. Waiting for confirmation; you can also check its explorer link.");
    // A timeout leaves the hash visible and prevents another write until checked.
    const result = await wallet.awaitTxConfirmation(hash, { timeout: 120000 });
    if (!result) throw new Error("Confirmation is not yet available. Check the transaction before submitting another update.");
    setPending(false);
    setMessage("Transaction confirmed.");
  }

  async function checkConfirmation() {
    if (!txHash) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/blockfrost/txs/${txHash}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Transaction is not confirmed yet. Keep its hash and check again.");
      setPending(false); setMessage("Transaction confirmed."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to check confirmation."); }
    finally { setBusy(false); }
  }

  async function initialize() {
    setBusy(true); setError(""); setMessage("");
    try {
      const wallet = await signingWallet();
      const tools = await import("@lucid-evolution/lucid");
      const credential = tools.getAddressDetails(address).paymentCredential;
      if (credential?.type !== "Key") throw new Error("An issuer payment-key wallet is required.");
      const seed = (await wallet.wallet().getUtxos()).find((u) => Object.keys(u.assets).length === 1 && (u.assets.lovelace ?? BigInt(0)) >= BigInt(10000000));
      if (!seed) throw new Error("Provide an ADA-only UTxO with at least 10 tADA for registry initialization.");
      const blueprint = await registryBlueprint();
      const name = tools.fromText("CSWAP_REGISTRY");
      const identity = { type: "PlutusV3" as const, script: tools.applyParamsToScript(blueprint.identity, [new tools.Constr(0, [seed.txHash, BigInt(seed.outputIndex)]), name]) };
      const token = tools.mintingPolicyToId(identity) + name;
      const script = registryScript(tools, blueprint.registry, token, credential.hash);
      const registryAddress = tools.validatorToAddress("Preprod", script);
      const tx = await wallet.newTx().collectFrom([seed]).mintAssets({ [token]: BigInt(1) }, tools.Data.to(new tools.Constr(0, []))).attach.MintingPolicy(identity)
        .pay.ToContract(registryAddress, { kind: "inline", value: registryDatum(tools, BigInt(0), []) }, { lovelace: BigInt(5000000), [token]: BigInt(1) }).addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      setDeployment({ token, issuer: credential.hash, address: registryAddress });
      await confirmed(wallet, hash);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Registry initialization failed."); }
    finally { setBusy(false); }
  }

  async function change(action: "register" | "revoke", value: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const unit = normalizeUnit(value);
      const wallet = await signingWallet();
      const tools = await import("@lucid-evolution/lucid");
      if (tools.getAddressDetails(address).paymentCredential?.hash !== registryIssuer) throw new Error("Only the configured issuer can update this registry.");
      if (action === "register") { setMessage("Verifying the original NFT mint…"); await verifyOriginalMint(unit); }
      // Read immediately before construction to avoid overwriting another update.
      const current = await readRegistry(wallet);
      const exists = current.entries.includes(unit);
      if (action === "register" && exists) throw new Error("Asset is already registered.");
      if (action === "revoke" && !exists) throw new Error("Asset is not registered.");
      if (action === "register" && current.entries.length >= MAX_REGISTRY_ENTRIES) throw new Error("Registry capacity reached. Revoke an entry before adding another.");
      const entries = action === "register" ? [unit, ...current.entries] : current.entries.filter((entry) => entry !== unit);
      const tx = await wallet.newTx().collectFrom([current.utxo], tools.Data.to(new tools.Constr(action === "register" ? 0 : 1, [assetData(tools, unit)]))).attach.SpendingValidator(current.script)
        .pay.ToContract(current.address, { kind: "inline", value: registryDatum(tools, current.version + BigInt(1), entries) }, { ...current.utxo.assets })
        .addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      await confirmed(wallet, hash);
      setAsset(""); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Registry update failed. Refresh and retry."); }
    finally { setBusy(false); }
  }


  function requestedUnits(): string[] {
    const units = requestAssets.split(/[\s,]+/).filter(Boolean).map(normalizeUnit);
    if (!units.length || units.length > MAX_REGISTRY_ENTRIES) throw new Error("Request between one and 50 asset IDs.");
    if (new Set(units).size !== units.length) throw new Error("Requested asset IDs must be unique.");
    return units;
  }

  async function loadCurrentRequest(wallet: LucidEvolution, id: string): Promise<{ registry: RegistryState; queue: RegistryRequestState; request: RegistryRequest }> {
    const registry = await readRegistry(wallet);
    const queue = await readRegistryRequests(wallet, registry);
    const request = queue.requests.find((candidate) => candidate.id === id);
    if (!request) throw new Error("Request is no longer pending. Refresh before trying again.");
    return { registry, queue, request };
  }

  async function submitRequest() {
    setBusy(true); setError(""); setMessage("");
    try {
      const units = requestedUnits();
      const wallet = await signingWallet();
      const tools = await import("@lucid-evolution/lucid");
      const credential = tools.getAddressDetails(address).paymentCredential;
      if (credential?.type !== "Key") throw new Error("A payment-key wallet is required to create a cancellable request.");
      const current = await readRegistry(wallet);
      const blueprint = await registryBlueprint();
      const script = registryRequestScript(tools, blueprint.request ?? "", current);
      const requestAddress = tools.validatorToAddress("Preprod", script);
      const tx = await wallet.newTx().pay.ToContract(requestAddress, { kind: "inline", value: registryRequestDatum(tools, address, credential.hash, units) }, { lovelace: REGISTRY_REQUEST_DEPOSIT }).addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      await confirmed(wallet, hash);
      setRequestAssets(""); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to submit the asset request."); }
    finally { setBusy(false); }
  }

  async function cancelRequest(id: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const wallet = await signingWallet();
      const tools = await import("@lucid-evolution/lucid");
      const { queue, request } = await loadCurrentRequest(wallet, id);
      if (tools.getAddressDetails(address).paymentCredential?.hash !== request.requesterKey) throw new Error("Only the requester payment-key wallet can cancel this request.");
      const tx = await wallet.newTx().collectFrom([request.utxo], tools.Data.to(new tools.Constr(2, []))).attach.SpendingValidator(queue.script).pay.ToAddress(request.requester, { lovelace: request.lockedLovelace }).addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      await confirmed(wallet, hash); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to cancel the request."); }
    finally { setBusy(false); }
  }

  async function rejectRequest(id: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const wallet = await signingWallet();
      const tools = await import("@lucid-evolution/lucid");
      const { registry, queue, request } = await loadCurrentRequest(wallet, id);
      const credential = tools.getAddressDetails(address).paymentCredential;
      if (credential?.type !== "Key" || credential.hash !== registry.issuer) throw new Error("Only the configured registry issuer can reject requests.");
      const tx = await wallet.newTx().collectFrom([request.utxo], tools.Data.to(new tools.Constr(1, []))).attach.SpendingValidator(queue.script).pay.ToAddress(request.requester, { lovelace: request.lockedLovelace }).addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      await confirmed(wallet, hash); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to reject the request."); }
    finally { setBusy(false); }
  }

  async function approveRequest(id: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const wallet = await signingWallet();
      const tools = await import("@lucid-evolution/lucid");
      const { registry, queue, request } = await loadCurrentRequest(wallet, id);
      const credential = tools.getAddressDetails(address).paymentCredential;
      if (credential?.type !== "Key" || credential.hash !== registry.issuer) throw new Error("Only the configured registry issuer can approve requests.");
      if (request.assets.some((unit) => registry.entries.includes(unit))) throw new Error("A requested asset is already registered. Reject the request and ask the user to resubmit the remaining assets.");
      if (registry.entries.length + request.assets.length > MAX_REGISTRY_ENTRIES) throw new Error("This approval would exceed the 50-asset registry capacity.");
      for (const unit of request.assets) { setMessage("Verifying original NFT mint: " + unit); await verifyOriginalMint(unit); }
      const entries = [...request.assets, ...registry.entries];
      const tx = await wallet.newTx().collectFrom([registry.utxo], tools.Data.to(new tools.Constr(2, [request.assets.map((unit) => assetData(tools, unit))]))).collectFrom([request.utxo], tools.Data.to(new tools.Constr(0, []))).attach.SpendingValidator(registry.script).attach.SpendingValidator(queue.script)
        .pay.ToContract(registry.address, { kind: "inline", value: registryDatum(tools, registry.version + BigInt(1), entries) }, { ...registry.utxo.assets }).pay.ToAddress(request.requester, { lovelace: request.lockedLovelace }).addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      await confirmed(wallet, hash); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to approve the request."); }
    finally { setBusy(false); }
  }
  return <div className="platform-shell">
    <PlatformHeader />
    <main className="page-main"><section className="hero"><div><span className="eyebrow">On-chain asset registry · Preprod</span><h1>CSWAP-approved assets</h1><p>Read issuer-approved asset IDs directly from the authenticated registry. Registration is an issuer approval, not a guarantee of the underlying real-world asset.</p></div></section>
      <RegistryGuide />
      {state && <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">Permissionless intake</span><h2>Request asset admission</h2></div></div><p>Request one or more exact asset IDs for the shared-pool registry. Your 3 tADA request deposit returns when you cancel, or when the Team approves or rejects it.</p><form onSubmit={(event) => { event.preventDefault(); void submitRequest(); }}><label className="field"><span className="field-label">Asset IDs</span><textarea value={requestAssets} onChange={(event) => setRequestAssets(event.target.value)} placeholder="Policy ID + asset name in hex, one per line or comma-separated" required disabled={busy || pending} rows={4} /></label><p>Each requested asset must be a complete policy ID plus asset name in hexadecimal. A request is not an approval.</p><button className="primary-button" type="submit" disabled={busy || pending || reading || walletStatus !== "connected"}>Submit asset request · 3 tADA refundable deposit</button></form><div className="registry-request-list"><h3>Pending requests</h3>{requestState?.requests.length ? requestState.requests.map((request) => <article key={request.id} className="calculation-card"><strong>{request.assets.length} requested asset{request.assets.length === 1 ? "" : "s"}</strong><p style={{ overflowWrap: "anywhere" }}>Requester: {request.requester}</p><ul>{request.assets.map((unit) => <li key={unit}><code>{unit}</code></li>)}</ul><p>Refundable deposit: {request.lockedLovelace.toString()} lovelace</p><div className="registry-request-actions">{isIssuer && <><button type="button" className="primary-button" disabled={busy || pending || reading} onClick={() => void approveRequest(request.id)}>Verify &amp; approve all</button><button type="button" disabled={busy || pending || reading} onClick={() => void rejectRequest(request.id)}>Reject &amp; refund</button></>}{walletKey === request.requesterKey && <button type="button" disabled={busy || pending || reading} onClick={() => void cancelRequest(request.id)}>Cancel &amp; refund</button>}</div></article>) : <p>No valid pending requests found.</p>}</div></section>}
      <section className="work-card form-card"><div className="section-heading"><h2>{registryConfigured ? "Registered assets" : "Initialize the registry"}</h2>{registryConfigured && <button type="button" onClick={() => void refresh()} disabled={busy || reading}>Refresh</button>}</div>
        {!hasConfiguration && <><p>Connect the issuer wallet to create an empty registry. That wallet will control registration and revocation. The registry locks its identity token and ADA; this basic version has no close or issuer-rotation action.</p><button className="primary-button" type="button" disabled={busy || pending || Boolean(deployment) || walletStatus !== "connected"} onClick={() => void initialize()}>Create registry</button></>}
        {hasConfiguration && !registryConfigured && <p role="alert">Set both the registry identity token and issuer key hash in the deployment configuration.</p>}
        {deployment && <div className="calculation-card"><strong>{pending ? "Deployment submitted — wait for confirmation" : "Deployment configuration"}</strong><p>After confirmation, add these public values to .env.local and restart the app. Keep the transaction hash for your deployment record.</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{`NEXT_PUBLIC_ASSET_REGISTRY_TOKEN=${deployment.token}\nNEXT_PUBLIC_ASSET_REGISTRY_ISSUER=${deployment.issuer}`}</pre><p style={{ overflowWrap: "anywhere" }}>Registry address: {deployment.address}</p></div>}
        {reading && <p role="status">Reading authenticated registry…</p>}
        {state && <><p>{state.entries.length} / {MAX_REGISTRY_ENTRIES} assets · Revision {state.version.toString()}</p><p style={{ overflowWrap: "anywhere" }}>Registry: {state.address}</p>
          {isIssuer && <form onSubmit={(event) => { event.preventDefault(); void change("register", asset); }}><label className="field"><span className="field-label">NFT asset ID</span><input value={asset} onChange={(event) => setAsset(event.target.value)} placeholder="Policy ID + asset name in hex" required disabled={busy || pending} /></label><p>The mint is checked against the current CSWAP NFT contract before requesting your signature.</p><button className="primary-button" type="submit" disabled={busy || pending || reading}>Register asset</button></form>}
          {!isIssuer && <p>Connect the configured issuer wallet to add or revoke assets.</p>}
          {state.entries.length === 0 ? <p>No assets registered yet.</p> : <ul>{state.entries.map((unit) => <li key={unit} style={{ padding: "12px 0", overflowWrap: "anywhere" }}><Link href={`/assets?asset=${unit}`}>{unit}</Link>{isIssuer && <button type="button" style={{ marginLeft: 12 }} disabled={busy || pending || reading} onClick={() => void change("revoke", unit)}>Revoke approval</button>}</li>)}</ul>}
        </>}
        {message && <p role="status" className="form-message success-message">{message}</p>}{error && <p role="alert" className="form-message error-message">{error}</p>}
        {txHash && <p><a href={`https://preprod.cexplorer.io/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>{pending && <button type="button" disabled={busy} onClick={() => void checkConfirmation()}>Check confirmation</button>}</p>}
      </section>
    </main>
  </div>;
}
