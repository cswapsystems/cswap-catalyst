"use client";

import { useEffect, useState } from "react";
import { useWallet } from "./wallet-context";

type WalletUtxo = { amount?: Array<{ unit?: string; quantity?: string }> };
type WalletAsset = { unit: string; quantity: string; name: string };
type Blueprint = { ftCompiledCode?: string; vaultCompiledCode?: string };

function decodeAssetName(unit: string) {
  const hex = unit.slice(56);
  if (!hex) return "Unnamed / binary";
  const bytes: number[] = [];
  for (let index = 0; index + 1 < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16);
    if (!Number.isFinite(byte)) return "Binary asset name";
    bytes.push(byte);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)) || "Unnamed / binary"; } catch { return "Binary asset name"; }
}

async function loadWalletAssets(address: string): Promise<WalletAsset[]> {
  const response = await fetch("/api/blockfrost/addresses/" + encodeURIComponent(address) + "/utxos?count=100", { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load assets from this wallet.");
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) return [];
  const quantities = new Map<string, bigint>();
  for (const utxo of payload as WalletUtxo[]) {
    for (const entry of utxo.amount || []) {
      if (!entry.unit || entry.unit === "lovelace" || !entry.quantity) continue;
      try { quantities.set(entry.unit, (quantities.get(entry.unit) || BigInt(0)) + BigInt(entry.quantity)); } catch { /* Ignore malformed quantities. */ }
    }
  }
  return Array.from(quantities).filter(([, quantity]) => quantity > BigInt(0)).map(([unit, quantity]) => ({ unit, quantity: quantity.toString(), name: decodeAssetName(unit) })).sort((a, b) => a.unit.localeCompare(b.unit));
}

function assetLabel(asset: WalletAsset) {
  return asset.name + " · " + asset.unit.slice(0, 14) + "…" + asset.unit.slice(-8) + " · " + new Intl.NumberFormat("en-US").format(Number(asset.quantity));
}

function utf8TokenName(name: string) {
  const base = name === "Unnamed / binary" || name === "Binary asset name" ? "RWA" : name;
  let result = "";
  for (const character of base + "-F") {
    if (new TextEncoder().encode(result + character).length > 32) break;
    result += character;
  }
  return result || "RWA-F";
}

function Field({ label, placeholder, hint, value, onChange, readOnly, select, options, disabled }: { label: string; placeholder: string; hint?: string; value?: string; onChange?: (value: string) => void; readOnly?: boolean; select?: boolean; options?: Array<{ value: string; label: string }>; disabled?: boolean }) {
  return <label className="field"><span className="field-label">{label}</span><span className="field-input-wrap">{select ? <select value={value || ""} onChange={(event) => onChange?.(event.target.value)} disabled={disabled}><option value="" disabled>{placeholder}</option>{options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : <input placeholder={placeholder} value={value} onChange={(event) => onChange?.(event.target.value)} readOnly={readOnly} disabled={disabled} />}{select && <span className="select-chevron">⌄</span>}</span>{hint && <span className="field-hint">{hint}</span>}</label>;
}

function Arrow() { return <span aria-hidden="true" className="button-arrow">↗</span>; }

export default function FractionalizeForm() {
  const { address } = useWallet();
  const [mode, setMode] = useState<"split" | "combine">("split");
  const [assets, setAssets] = useState<WalletAsset[]>([]);
  const [assetStatus, setAssetStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [selectedUnit, setSelectedUnit] = useState("");
  const [fractionCount, setFractionCount] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selectedAsset = assets.find((asset) => asset.unit === selectedUnit);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setAssetStatus("loading"); });
    void loadWalletAssets(address).then((walletAssets) => { if (!cancelled) { setAssets(walletAssets); setAssetStatus("ready"); } }).catch(() => { if (!cancelled) { setAssets([]); setAssetStatus("error"); } });
    return () => { cancelled = true; };
  }, [address]);

  async function reviewFractions() {
    setMessage(null);
    setError(null);
    if (!address) { setError("Connect Eternl before fractionalizing an asset."); return; }
    if (!selectedAsset) { setError("Select an RWA asset from your connected wallet."); return; }
    if (!/^[1-9]\d*$/.test(fractionCount)) { setError("Enter a whole number of fractions greater than zero."); return; }

    setSubmitting(true);
    try {
      if (!window.cardano?.eternl) throw new Error("Install Eternl and switch it to Preprod.");
      const api = await window.cardano.eternl.enable();
      if (await api.getNetworkId() !== 0) throw new Error("Eternl must be set to Cardano Preprod.");
      const { Blockfrost, Constr, Data, Lucid, applyParamsToScript, fromText, getAddressDetails, mintingPolicyToId, validatorToAddress, validatorToScriptHash } = await import("@lucid-evolution/lucid");
      const blueprintResponse = await fetch("/api/fractionalize-blueprint", { cache: "no-store" });
      const blueprint = await blueprintResponse.json() as Blueprint & { error?: string };
      if (!blueprintResponse.ok || !blueprint.ftCompiledCode || !blueprint.vaultCompiledCode) throw new Error(blueprint.error || "Unable to load the fractionalization validators.");
      const lucid = await Lucid(new Blockfrost("/api/blockfrost", ""), "Preprod");
      lucid.selectWallet.fromAPI(api);
      const walletAddress = await lucid.wallet().address();
      if (walletAddress !== address) throw new Error("The connected wallet changed. Refresh the asset list and try again.");
      const source = (await lucid.utxosAt(walletAddress)).find((utxo) => (utxo.assets[selectedAsset.unit] || BigInt(0)) >= BigInt(1));
      if (!source) throw new Error("The selected asset is no longer in the connected wallet.");

      const fractionTotal = BigInt(fractionCount);
      const seed = new Constr(0, [source.txHash, BigInt(source.outputIndex)]);
      const vaultValidator = { type: "PlutusV3" as const, script: blueprint.vaultCompiledCode };
      const vaultAddress = validatorToAddress("Preprod", vaultValidator);
      const vaultScriptHash = validatorToScriptHash(vaultValidator);
      const fractionPolicy = { type: "PlutusV3" as const, script: applyParamsToScript(blueprint.ftCompiledCode, [seed, vaultScriptHash]) };
      const fractionPolicyId = mintingPolicyToId(fractionPolicy);
      const fractionName = fromText(utf8TokenName(selectedAsset.name));
      const fractionUnit = fractionPolicyId + fractionName;
      const paymentCredential = getAddressDetails(walletAddress).paymentCredential;
      if (!paymentCredential || paymentCredential.type !== "Key") throw new Error("The connected wallet has no payment key credential.");
      const vaultDatum = new Constr(0, [paymentCredential.hash, selectedAsset.unit.slice(0, 56), selectedAsset.unit.slice(56), fractionPolicyId, fractionName, fractionTotal]);
      const tx = await lucid.newTx()
        .collectFrom([source])
        .mintAssets({ [fractionUnit]: fractionTotal }, Data.to(new Constr(0, [fractionTotal, fractionName])))
        .attach.MintingPolicy(fractionPolicy)
        .pay.ToContract(vaultAddress, { kind: "inline", value: Data.to(vaultDatum) }, { lovelace: BigInt(3_000_000), [selectedAsset.unit]: BigInt(1) })
        .pay.ToAddress(walletAddress, { [fractionUnit]: fractionTotal })
        .complete();
      const txHash = await (await tx.sign.withWallet().complete()).submit();
      setMessage("Fractionalization submitted: " + txHash + ". The NFT is locked in the vault and fractions were sent to your wallet.");
      setSelectedUnit("");
      setFractionCount("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Fractionalization failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const assetOptions = assets.map((asset) => ({ value: asset.unit, label: assetLabel(asset) }));
  const assetPlaceholder = !address ? "Connect Eternl first" : assetStatus === "loading" ? "Loading wallet assets…" : assets.length ? "Choose an asset" : "No native assets found";
  const tokenToReceive = selectedAsset ? selectedAsset.name + " fractions" : "";
  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">01 / Position setup</span><h2>{mode === "split" ? "Create fractional ownership" : "Combine your fractional units"}</h2></div><span className="step-badge">1 of 2</span></div><div className="segmented-control"><button type="button" className={mode === "split" ? "selected" : ""} onClick={() => setMode("split")}>Fractionalize</button><button type="button" className={mode === "combine" ? "selected" : ""} onClick={() => setMode("combine")}>Combine</button></div><div className="field-grid"><Field label="Select RWA asset" placeholder={assetPlaceholder} hint="Assets are read from the connected wallet." select options={assetOptions} value={selectedUnit} onChange={(value) => { setSelectedUnit(value); setMessage(null); setError(null); }} disabled={!address || assetStatus === "loading" || assets.length === 0} /><Field label={mode === "split" ? "Number of fractions" : "Units to combine"} placeholder={mode === "split" ? "e.g. 1,000" : "e.g. 250"} value={fractionCount} onChange={(value) => { setFractionCount(value); setMessage(null); setError(null); }} /><Field label="Token you receive" placeholder="Created automatically" value={mode === "split" ? tokenToReceive : "Original RWA token"} hint="A new fungible token representing fractional ownership." readOnly /><Field label="Recipient wallet" placeholder="Connect Eternl first" value={address} hint="Fractions are sent to the connected wallet." readOnly /></div>{selectedAsset && <div className="asset-selection-note"><span>Selected asset name (UTF-8)</span><strong>{selectedAsset.name}</strong><code>{selectedAsset.unit}</code></div>}{error && <p className="form-message error-message" role="alert">{error}</p>}{message && <p className="form-message success-message" role="status">{message}</p>}<div className="calculation-card"><span>{mode === "split" ? "Fractionalization preview" : "Combination preview"}</span><strong>{selectedAsset ? selectedAsset.name + " → " + fractionCount + " ownership units" : "Select an asset and enter a fraction amount"}</strong><p>The NFT will be locked in the vault and the newly minted fraction token will be sent to the connected wallet.</p></div><div className="form-footer"><p><span className="status-dot" /> {submitting ? "Awaiting Eternl signature…" : "Ready for review and signing."}</p><button type="button" className="primary-button" onClick={() => void reviewFractions()} disabled={submitting}>{submitting ? "Building transaction…" : "Review & fractionalize"} <Arrow /></button></div></section>;
}
