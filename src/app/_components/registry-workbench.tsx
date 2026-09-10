"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import PlatformHeader from "./platform-header";
import RegistryGuide from "./registry-guide";
import { useWallet } from "./wallet-context";
import { assetData, checkRegistryNetwork, MAX_REGISTRY_ENTRIES, normalizeUnit, readRegistry, registryBlueprint, registryConfigured, registryDatum, registryIssuer, registryScript, registryToken, verifyOriginalMint, type RegistryState } from "@/lib/asset-registry";

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
  const hasConfiguration = Boolean(registryToken || registryIssuer);

  const refresh = useCallback(async () => {
    if (!registryConfigured) return;
    setReading(true);
    setError("");
    try { setState(await readRegistry()); }
    catch (cause) { setState(null); setError(cause instanceof Error ? cause.message : "Registry could not be read."); }
    finally { setReading(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void import("@lucid-evolution/lucid").then((tools) => {
      const credential = address ? tools.getAddressDetails(address).paymentCredential : undefined;
      if (!cancelled) setIsIssuer(walletStatus === "connected" && credential?.type === "Key" && credential.hash === registryIssuer);
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

  return <div className="platform-shell">
    <PlatformHeader />
    <main className="page-main"><section className="hero"><div><span className="eyebrow">On-chain asset registry · Preprod</span><h1>CSWAP-approved assets</h1><p>Read issuer-approved asset IDs directly from the authenticated registry. Registration is an issuer approval, not a guarantee of the underlying real-world asset.</p></div></section>
      <RegistryGuide />
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
