"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import PlatformHeader from "./platform-header";
import RegistryGuide from "./registry-guide";
import { useWallet } from "./wallet-context";
import { assertWalletSession } from "@/lib/wallet-guard";
import { summarizeWalletAssets, type WalletAsset } from "@/lib/wallet-assets";
import { formatAda } from "@/lib/ada";
import { assetData, checkRegistryNetwork, MAX_REGISTRY_ENTRIES, normalizeUnit, readRegistry, readRegistryRequests, registryBlueprint, registryConfigured, registryDatum, registryIssuer, registryReader, registryRequestDatum, REGISTRY_REQUEST_DEPOSIT, registryRequestScript, registryScript, verifyOriginalMint, type RegistryRequest, type RegistryRequestState, type RegistryState } from "@/lib/asset-registry";

export default function RegistryWorkbench({ audience = "operator" }: { audience?: "owner" | "operator" }) {
  const { lucid, address, status: walletStatus, connect } = useWallet();
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
  const [requestState, setRequestState] = useState<RegistryRequestState | null>(null);
  const [walletRwaAssets, setWalletRwaAssets] = useState<WalletAsset[]>([]);
  const [walletRwaStatus, setWalletRwaStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [walletRwaError, setWalletRwaError] = useState("");
  const [selectedRequestUnits, setSelectedRequestUnits] = useState<string[]>([]);

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

  useEffect(() => {
    if (!lucid || !address || walletStatus !== "connected") {
      setWalletRwaAssets([]);
      setWalletRwaStatus("idle");
      setWalletRwaError("");
      setSelectedRequestUnits([]);
      return;
    }

    let cancelled = false;
    setWalletRwaStatus("loading");
    setWalletRwaError("");
    void (async () => {
      try {
        const holdings = summarizeWalletAssets(await lucid.wallet().getUtxos());
        const candidates = holdings.assets.filter((asset) => asset.quantity === BigInt(1));
        const verified = await Promise.all(candidates.map(async (asset) => {
          try {
            await verifyOriginalMint(asset.unit);
            return asset;
          } catch {
            return null;
          }
        }));
        if (!cancelled) {
          setWalletRwaAssets(verified.filter((asset): asset is WalletAsset => asset !== null));
          setWalletRwaStatus("ready");
        }
      } catch (cause) {
        if (!cancelled) {
          setWalletRwaAssets([]);
          setWalletRwaStatus("error");
          setWalletRwaError(cause instanceof Error ? cause.message : "Unable to read RWA assets from the connected wallet.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [address, lucid, walletStatus]);

  async function signingWallet(): Promise<LucidEvolution> {
    checkRegistryNetwork();
    if (!lucid || !address || walletStatus !== "connected" || !window.cardano?.eternl) throw new Error("Connect Eternl on Preprod first.");
    const api = await window.cardano.eternl.enable();
    if (await api.getNetworkId() !== 0) throw new Error("Switch Eternl to Preprod.");
    lucid.selectWallet.fromAPI(api);
    await assertWalletSession(lucid, address);
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
      if (registryConfigured && credential.hash !== registryIssuer) throw new Error("Only the configured registry issuer can deploy a replacement registry.");
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
      await assertWalletSession(wallet, address);
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
      await assertWalletSession(wallet, address);
      const hash = await (await tx.sign.withWallet().complete()).submit();
      await confirmed(wallet, hash);
      setAsset(""); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Registry update failed. Refresh and retry."); }
    finally { setBusy(false); }
  }


  function requestedUnits(): string[] {
    if (!selectedRequestUnits.length || selectedRequestUnits.length > MAX_REGISTRY_ENTRIES) throw new Error("Select between one and 50 RWA assets from your wallet.");
    if (new Set(selectedRequestUnits).size !== selectedRequestUnits.length) throw new Error("Selected asset IDs must be unique.");
    return selectedRequestUnits;
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
      await assertWalletSession(wallet, address);
      const hash = await (await tx.sign.withWallet().complete()).submit();
      await confirmed(wallet, hash);
      setSelectedRequestUnits([]); await refresh();
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
      await assertWalletSession(wallet, address);
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
      await assertWalletSession(wallet, address);
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
      await assertWalletSession(wallet, address);
      const hash = await (await tx.sign.withWallet().complete()).submit();
      await confirmed(wallet, hash); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to approve the request."); }
    finally { setBusy(false); }
  }
  const supportedCount = state?.entries.length ?? 0;
  const requestCount = requestState?.requests.length ?? 0;
  const ownRequests = requestState?.requests.filter((request) => walletKey && request.requesterKey === walletKey) ?? [];
  const requestableWalletAssets = useMemo(() => walletRwaAssets.filter((asset) => !state?.entries.includes(asset.unit)), [state?.entries, walletRwaAssets]);
  const selectionLimitReached = selectedRequestUnits.length >= MAX_REGISTRY_ENTRIES;

  useEffect(() => {
    const requestableUnits = new Set(requestableWalletAssets.map((asset) => asset.unit));
    setSelectedRequestUnits((selected) => selected.filter((unit) => requestableUnits.has(unit)));
  }, [requestableWalletAssets]);

  return <div className="platform-shell">
    <PlatformHeader />
    <main id="main-content" tabIndex={-1} className="page-main">
      <section className="hero">
        <div><span className="eyebrow">On-chain asset registry · Preprod</span><h1>{audience === "owner" ? "Asset support requests" : "Asset approvals"}</h1><p>{audience === "owner" ? "Request review for an original RWA asset, track your pending requests, or cancel one you submitted." : "Review support requests and manage the registry as the configured Team issuer."}</p></div>
      </section>

      <section className="registry-control-status">
        <div className="registry-control-status-head">
          <div><span className="section-kicker">Start here</span><h2>Registry status</h2><p>{state ? "The authenticated registry is ready for requests and Team review." : reading ? "Checking the authenticated on-chain registry…" : "Resolve registry status before support requests can be submitted."}</p></div>
          {registryConfigured && <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={busy || reading}>{reading ? "Refreshing…" : "↻ Refresh"}</button>}
        </div>

        {state && <><div className="registry-control-status-grid">
          <dl><dt>Status</dt><dd><i aria-hidden="true" /> Active</dd><p>Authenticated identity UTxO found</p></dl>
          <dl><dt>Supported assets</dt><dd>{supportedCount}</dd><p>of {MAX_REGISTRY_ENTRIES} registry capacity</p></dl>
          <dl><dt>Pending reviews</dt><dd>{requestCount}</dd><p>request{requestCount === 1 ? "" : "s"} awaiting a Team decision</p></dl>
          <dl><dt>Registry revision</dt><dd>{state.version.toString()}</dd><p>increments for each allowlist change</p></dl>
        </div><details className="registry-control-details"><summary>View registry address and identity</summary><dl><div><dt>Registry address</dt><dd><code>{state.address}</code></dd></div><div><dt>Identity token</dt><dd><code>{state.token}</code></dd></div></dl></details></>}

        {!registryConfigured && (audience === "operator" ? <div className="registry-redeploy-callout"><div><strong>Create the first registry</strong><p>No public registry deployment is configured for this environment. The issuer wallet will mint the registry identity NFT and create the empty registry state.</p></div><button type="button" className="primary-button" disabled={busy || pending || walletStatus !== "connected" || Boolean(deployment)} onClick={() => void initialize()}>Create registry</button></div> : <p role="alert" className="registry-action-blocked">Asset requests are unavailable until the Team configures the registry.</p>)}
        {!state && reading && <p role="status" className="form-message">Reading the authenticated registry state…</p>}
        {!state && !reading && registryConfigured && <>
          <p role="alert" className="form-message error-message">{error || "The authenticated registry state is unavailable. Requests need an active deployed registry."}</p>
          {audience === "owner" ? <p className="registry-redeploy-note">Requests are unavailable until the registry can be read. Refresh later or contact the Team; do not resubmit an unresolved transaction.</p> : isIssuer
            ? <div className="registry-redeploy-callout"><div><strong>Deploy a replacement registry</strong><p>The configured identity token belongs to the previous validator and cannot move to this request-enabled validator. This creates a new empty registry identity; re-approve reviewed assets after deployment.</p></div><button type="button" className="primary-button" disabled={busy || pending || Boolean(deployment)} onClick={() => void initialize()}>{pending ? "Deployment submitted…" : "Deploy replacement registry"}</button></div>
            : <p className="registry-redeploy-note">A connected Team issuer wallet must resolve the registry configuration before requests can be submitted.</p>}
        </>}
        {audience === "operator" && deployment && <div className="calculation-card registry-deployment-result"><strong>{pending ? "Deployment submitted — wait for confirmation" : "Replacement registry ready to configure"}</strong><p>After confirmation, update the two public values below, then restart or rebuild the app before submitting requests.</p><pre>{"NEXT_PUBLIC_ASSET_REGISTRY_TOKEN=" + deployment.token + "\nNEXT_PUBLIC_ASSET_REGISTRY_ISSUER=" + deployment.issuer}</pre><p>Registry address: <code>{deployment.address}</code></p></div>}
        {message && <p role="status" className="form-message success-message">{message}</p>}
        {state && error && <p role="alert" className="form-message error-message">{error}</p>}
        {txHash && <p className="registry-transaction"><a href={"https://preprod.cexplorer.io/tx/" + txHash} target="_blank" rel="noreferrer">View transaction ↗</a>{pending && <button type="button" disabled={busy} onClick={() => void checkConfirmation()}>Check confirmation</button>}</p>}
      </section>

      <div className={audience === "owner" ? "registry-control-workflow" : "registry-control-workflow registry-operator-workflow"}>
        {audience === "owner" && <section id="request-asset-admission" className="registry-control-card registry-control-request">
          <div className="registry-control-card-head"><span>1</span><div><span className="section-kicker">For asset owners</span><h2>Request support</h2></div></div>
          <p>Select original RWA assets in this wallet for Team review. The 3 tADA deposit returns when you cancel or the Team decides; transaction fees still apply. Approval alone does not enable Instant Sell: the Team must also post an on-chain price and the pool needs available reserves.</p>
          {!state && <p className="registry-action-blocked">Requests unlock once the registry status above is active.</p>}
          {state && walletStatus !== "connected" && <div className="registry-request-connect"><p>Connect an Eternl wallet to create a request. No issuer access is required.</p><button className="primary-button" type="button" onClick={() => void connect()} disabled={walletStatus === "connecting"}>{walletStatus === "connecting" ? "Connecting…" : "Connect Eternl"}</button></div>}
          {state && walletStatus === "connected" && <form onSubmit={(event) => { event.preventDefault(); void submitRequest(); }}>
            <fieldset className="registry-asset-picker" disabled={busy || pending || walletRwaStatus === "loading"}>
              <legend><span className="field-label">Choose RWA assets from your wallet</span><small>Only quantity-one tokens minted through the supported CSWAP original-asset policy are shown.</small></legend>
              {walletRwaStatus === "loading" && <p className="registry-picker-status" role="status">Checking your wallet for supported original RWA assets…</p>}
              {walletRwaStatus === "error" && <p className="form-message error-message" role="alert">{walletRwaError}</p>}
              {walletRwaStatus === "ready" && requestableWalletAssets.length === 0 && <p className="registry-picker-status">No requestable original RWA assets were found in this wallet. Assets already approved in the registry are excluded.</p>}
              {walletRwaStatus === "ready" && requestableWalletAssets.length > 0 && <ul className="registry-asset-picker-list">{requestableWalletAssets.map((asset) => {
                const selected = selectedRequestUnits.includes(asset.unit);
                return <li key={asset.unit}><label className={selected ? "selected" : ""}><input type="checkbox" checked={selected} disabled={busy || pending || (!selected && selectionLimitReached)} onChange={(event) => { const checked = event.target.checked; setSelectedRequestUnits((current) => checked ? [...current, asset.unit] : current.filter((unit) => unit !== asset.unit)); }} /><span className="registry-picker-check" aria-hidden="true">✓</span><span className="registry-picker-asset"><strong>{asset.name}</strong><small>1 original NFT · {asset.policyId.slice(0, 12)}…{asset.policyId.slice(-8)}</small><code>{asset.unit}</code></span></label></li>;
              })}</ul>}
            </fieldset>
            <p className="registry-picker-selection">{selectedRequestUnits.length ? selectedRequestUnits.length + " asset" + (selectedRequestUnits.length === 1 ? "" : "s") + " selected for review." : "Choose at least one asset to request shared-pool support."}</p>
            <button className="primary-button" type="submit" disabled={busy || pending || reading || walletRwaStatus !== "ready" || selectedRequestUnits.length === 0}>{pending ? "Request submitted…" : "Request shared-pool support · 3 tADA"}</button>
          </form>}
        </section>}

        <section className="registry-control-card registry-control-queue">
          <div className="registry-control-card-head"><span>{audience === "owner" ? "2" : "1"}</span><div><span className="section-kicker">{audience === "owner" ? "Your on-chain requests" : "Team review queue"}</span><h2>{audience === "owner" ? "Your pending requests" : "Pending requests"}</h2></div><b>{audience === "owner" ? ownRequests.length : requestCount}</b></div>
          <p>{audience === "owner" ? "Requests appear here after confirmation. You can cancel only requests made with this wallet. Resolved requests leave the queue; check the public approved-asset list for current approval." : "Each request below is a live UTxO. Only the Team issuer can approve or reject it; requesters can cancel their own request."}</p>
          {!state && <p className="registry-action-blocked">The pending queue appears after the registry status above is active.</p>}
          {state && (audience === "owner" && walletStatus !== "connected" ? <div className="registry-queue-empty"><strong>Connect your wallet to view requests</strong><p>Only requests submitted by the connected payment key appear here.</p></div> : (audience === "owner" ? ownRequests : requestState?.requests ?? []).length ? <div className="registry-request-list">{(audience === "owner" ? ownRequests : requestState?.requests ?? []).map((request) => <article key={request.id} className="calculation-card"><strong>{request.assets.length} requested asset{request.assets.length === 1 ? "" : "s"}</strong><p>Requester: <code>{request.requester}</code></p><ul>{request.assets.map((unit) => <li key={unit}><Link href={"/assets?asset=" + unit}><code>{unit}</code></Link></li>)}</ul><p>Refundable deposit: {formatAda(request.lockedLovelace)} ADA</p><div className="registry-request-actions">{audience === "operator" && isIssuer && <><button type="button" className="primary-button" disabled={busy || pending || reading} onClick={() => void approveRequest(request.id)}>Verify &amp; approve all</button><button type="button" disabled={busy || pending || reading} onClick={() => void rejectRequest(request.id)}>Reject &amp; refund</button></>}{audience === "owner" && walletKey === request.requesterKey && <button type="button" disabled={busy || pending || reading} onClick={() => void cancelRequest(request.id)}>Cancel &amp; refund</button>}</div></article>)}</div> : <div className="registry-queue-empty"><strong>{audience === "owner" ? "You have no pending requests" : "No requests waiting for review"}</strong><p>{audience === "owner" ? "A confirmed request from this wallet will appear here until it is approved, rejected, or cancelled." : "The next submitted support request will appear here."}</p></div>)}
        </section>
      </div>

      {audience === "operator" && <section id="team-registry-administration" className="registry-control-admin">
        <div className="registry-control-admin-head"><div><span className="section-kicker">2 · Team issuer</span><h2>Manage approved assets</h2><p>Direct registration and revocation update the issuer&apos;s exact-asset approval record. Shared-pool prices are managed separately.</p></div><Link href="/asset-registry">View public registry <span aria-hidden="true">→</span></Link></div>
        {!state && <p className="registry-action-blocked">Activate the registry before managing its allowlist.</p>}
        {state && <div className="registry-admin-layout">
          <div className="registry-admin-action"><span className="section-kicker">Issuer action</span><h3>Approve an asset directly</h3>{isIssuer ? <form onSubmit={(event) => { event.preventDefault(); void change("register", asset); }}><label className="field"><span className="field-label">Original NFT asset ID</span><input value={asset} onChange={(event) => setAsset(event.target.value)} placeholder="Policy ID + asset name in hex" required disabled={busy || pending} /></label><p>The app verifies the supported CSWAP mint provenance before requesting the issuer signature.</p><button className="primary-button" type="submit" disabled={busy || pending || reading}>Register asset directly</button></form> : <p className="registry-action-blocked">Connect the configured Team issuer wallet to directly approve or revoke assets.</p>}</div>
          <div className="registry-approved-list"><div><span className="section-kicker">Live approval list</span><h3>Approved assets <b>{supportedCount}</b></h3></div>{state.entries.length === 0 ? <p className="registry-queue-empty">No assets are approved in the registry yet.</p> : <ul>{state.entries.map((unit) => <li key={unit}><Link href={"/assets?asset=" + unit}><code>{unit}</code></Link>{isIssuer && <button type="button" disabled={busy || pending || reading} onClick={() => void change("revoke", unit)}>Revoke</button>}</li>)}</ul>}</div>
        </div>}
      </section>}

      {audience === "owner" ? <section className="registry-control-admin"><div className="registry-control-admin-head"><div><span className="section-kicker">What happens next</span><h2>After Team review</h2><p>Approval is an issuer record, not a price or a sale. For Instant Sell, the Team must post an exact-asset on-chain price and the shared pool must have enough available cash. Then return to your Portfolio to request a sale.</p></div><Link href="/asset-registry">View approved assets →</Link></div></section> : <RegistryGuide />}
    </main>
  </div>;
}
