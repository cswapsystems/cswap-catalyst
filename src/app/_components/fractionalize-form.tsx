"use client";

import { useEffect, useState } from "react";
import { useWallet } from "./wallet-context";

type WalletUtxo = { amount?: Array<{ unit?: string; quantity?: string }> };
type WalletAsset = { unit: string; quantity: string; name: string; fractionUnit?: string; requiredFractions?: string; owner?: string; recoveryAdmin?: string };
type Blueprint = { ftCompiledCode?: string; vaultCompiledCode?: string; recoveryAdmin?: string };

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
  const locked = asset.requiredFractions ? " · requires " + asset.requiredFractions + " fractions" : "";
  return asset.name + " · " + asset.unit.slice(0, 14) + "…" + asset.unit.slice(-8) + " · " + new Intl.NumberFormat("en-US").format(Number(asset.quantity)) + locked;
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

type DataConstr = { index: number; fields: unknown[] };

function asConstr(value: unknown, label: string): DataConstr {
  if (typeof value !== "object" || value === null || !("index" in value) || !("fields" in value)) throw new Error("Malformed " + label + " datum.");
  const candidate = value as { index: unknown; fields: unknown };
  if (typeof candidate.index !== "number" || !Array.isArray(candidate.fields)) throw new Error("Malformed " + label + " datum.");
  return { index: candidate.index, fields: candidate.fields };
}

type VaultSnapshot = { nftUnit: string; ftPolicy: string; ftName: string; totalFractions: bigint; seed: unknown; ownerData: unknown; owner: string; recoveryAdmin: string };

function decodeVaultDatum(value: unknown, tools: typeof import("@lucid-evolution/lucid")): VaultSnapshot {
  const root = asConstr(value, "vault");
  if (root.index !== 0 || root.fields.length !== 8 || typeof root.fields[1] !== "string" || typeof root.fields[2] !== "string" || typeof root.fields[3] !== "string" || typeof root.fields[4] !== "string" || typeof root.fields[5] !== "string" || typeof root.fields[6] !== "bigint") throw new Error("Malformed vault datum.");
  const addressRoot = asConstr(root.fields[0], "vault owner");
  const credential = asConstr(addressRoot.fields[0], "owner credential");
  if (credential.fields.length !== 1 || typeof credential.fields[0] !== "string") throw new Error("Malformed vault owner credential.");
  const payment = { type: credential.index === 0 ? "Key" as const : "Script" as const, hash: credential.fields[0] };
  let owner: string;
  if (addressRoot.fields[1] === null) owner = tools.credentialToAddress("Preprod", payment);
  else {
    const stake = asConstr(addressRoot.fields[1], "owner stake option");
    const stakeCredential = asConstr(stake.fields[0], "owner stake credential");
    if (stakeCredential.fields.length !== 1 || typeof stakeCredential.fields[0] !== "string") throw new Error("Malformed owner stake credential.");
    owner = tools.credentialToAddress("Preprod", payment, { type: stakeCredential.index === 0 ? "Key" : "Script", hash: stakeCredential.fields[0] });
  }
  asConstr(root.fields[7], "vault seed");
  return {
    ownerData: root.fields[0], owner, recoveryAdmin: root.fields[1],
    nftUnit: root.fields[2] + root.fields[3],
    ftPolicy: root.fields[4],
    ftName: root.fields[5],
    totalFractions: root.fields[6],
    seed: root.fields[7],
  };
}

async function loadVaultAssets(lucid: import("@lucid-evolution/lucid").LucidEvolution): Promise<WalletAsset[]> {
  const response = await fetch("/api/fractionalize-blueprint", { cache: "no-store" });
  const blueprint = await response.json() as Blueprint & { error?: string };
  if (!response.ok || !blueprint.vaultCompiledCode) throw new Error(blueprint.error || "Unable to load the vault validator.");
  const tools = await import("@lucid-evolution/lucid");
  const { Data, validatorToAddress } = tools;
  const vaultAddress = validatorToAddress("Preprod", { type: "PlutusV3", script: blueprint.vaultCompiledCode });
  const assets: WalletAsset[] = [];
  for (const utxo of await lucid.utxosAt(vaultAddress)) {
    if (!utxo.datum) continue;
    try {
      const datum = decodeVaultDatum(Data.from(utxo.datum), tools);
      assets.push({
        unit: datum.nftUnit,
        quantity: "1",
        name: decodeAssetName(datum.nftUnit),
        fractionUnit: datum.ftPolicy + datum.ftName,
        requiredFractions: datum.totalFractions.toString(),
        owner: datum.owner,
        recoveryAdmin: datum.recoveryAdmin,
      });
    } catch {
      // Ignore unrelated or legacy vault outputs.
    }
  }
  return assets.sort((a, b) => a.unit.localeCompare(b.unit));
}

function Field({ label, placeholder, hint, value, onChange, readOnly, select, options, disabled }: { label: string; placeholder: string; hint?: string; value?: string; onChange?: (value: string) => void; readOnly?: boolean; select?: boolean; options?: Array<{ value: string; label: string }>; disabled?: boolean }) {
  return <label className="field"><span className="field-label">{label}</span><span className="field-input-wrap">{select ? <select value={value || ""} onChange={(event) => onChange?.(event.target.value)} disabled={disabled}><option value="" disabled>{placeholder}</option>{options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : <input placeholder={placeholder} value={value} onChange={(event) => onChange?.(event.target.value)} readOnly={readOnly} disabled={disabled} />}{select && <span className="select-chevron">⌄</span>}</span>{hint && <span className="field-hint">{hint}</span>}</label>;
}

function Arrow() { return <span aria-hidden="true" className="button-arrow">↗</span>; }

export default function FractionalizeForm() {
  const { address, lucid, connect } = useWallet();
  const [mode, setMode] = useState<"split" | "combine" | "recover">("split");
  const [assets, setAssets] = useState<WalletAsset[]>([]);
  const [assetStatus, setAssetStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [selectedUnit, setSelectedUnit] = useState("");
  const [fractionCount, setFractionCount] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selectedAsset = assets.find((asset) => asset.unit === selectedUnit);

  useEffect(() => {
    if (!address || (mode !== "split" && !lucid)) {
      const timer = window.setTimeout(() => {
        setAssets([]);
        setAssetStatus("idle");
      }, 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setAssetStatus("loading"); });
    const load = mode !== "split" ? loadVaultAssets(lucid as import("@lucid-evolution/lucid").LucidEvolution) : loadWalletAssets(address);
    void load.then((availableAssets) => { if (!cancelled) { setAssets(availableAssets); setAssetStatus("ready"); } }).catch(() => { if (!cancelled) { setAssets([]); setAssetStatus("error"); } });
    return () => { cancelled = true; };
  }, [address, lucid, mode]);

  function changeMode(nextMode: "split" | "combine" | "recover") {
    setMode(nextMode);
    setSelectedUnit("");
    setFractionCount("");
    setMessage(null);
    setError(null);
  }

  async function reviewFractions() {
    setMessage(null);
    setError(null);
    if (!address) { setError("Connect Eternl before fractionalizing an asset."); return; }
    if (!selectedAsset) { setError("Select an asset from your connected wallet."); return; }
    if (!/^[1-9]\d*$/.test(fractionCount)) { setError("Enter a whole number of fractions greater than zero."); return; }

    setSubmitting(true);
    try {
      const lucid = await connect();
      if (!lucid) throw new Error("Unable to connect Eternl. Check the wallet connection message.");
      const tools = await import("@lucid-evolution/lucid");
      const { Constr, Data, applyParamsToScript, fromText, getAddressDetails, mintingPolicyToId, validatorToAddress, validatorToScriptHash } = tools;
      const blueprintResponse = await fetch("/api/fractionalize-blueprint", { cache: "no-store" });
      const blueprint = await blueprintResponse.json() as Blueprint & { error?: string };
      if (!blueprintResponse.ok || !blueprint.ftCompiledCode || !blueprint.vaultCompiledCode) throw new Error(blueprint.error || "Unable to load the fractionalization validators.");
      const walletAddress = await lucid.wallet().address();
      if (walletAddress !== address) throw new Error("The connected wallet changed. Refresh the asset list and try again.");

      const vaultValidator = { type: "PlutusV3" as const, script: blueprint.vaultCompiledCode };
      const vaultAddress = validatorToAddress("Preprod", vaultValidator);
      const vaultScriptHash = validatorToScriptHash(vaultValidator);

      if (mode !== "split") {
        const vaultUtxos = await lucid.utxosAt(vaultAddress);
        const selectedUnit = selectedAsset.unit;
        let match: { utxo: (typeof vaultUtxos)[number]; datum: VaultSnapshot } | undefined;
        for (const utxo of vaultUtxos) {
          if (!utxo.datum) continue;
          try {
            const datum = decodeVaultDatum(Data.from(utxo.datum), tools);
            if (datum.nftUnit === selectedUnit) {
              match = { utxo, datum };
              break;
            }
          } catch {
            // Ignore unrelated or legacy vault outputs.
          }
        }
        if (!match) throw new Error("No matching vault was found for this original asset.");

        const { utxo: vaultUtxo, datum } = match;
        const requestedTotal = BigInt(fractionCount);
        if (mode === "combine" && requestedTotal !== datum.totalFractions) throw new Error("Combine requires the full fraction supply: " + datum.totalFractions.toString() + ".");
        if (mode === "recover" && (requestedTotal <= BigInt(0) || requestedTotal >= datum.totalFractions)) throw new Error("Partial recovery must burn fewer than the original " + datum.totalFractions.toString() + " fractions.");
        const walletFractionQuantity = (await lucid.utxosAt(walletAddress)).reduce(
          (total, utxo) => total + (utxo.assets[datum.ftPolicy + datum.ftName] || BigInt(0)),
          BigInt(0),
        );
        const burnAmount = mode === "combine" ? datum.totalFractions : requestedTotal;
        if (walletFractionQuantity < burnAmount) throw new Error("This wallet does not hold the fractions required for this recovery.");
        const signer = getAddressDetails(walletAddress).paymentCredential;
        if (mode === "recover" && (signer?.type !== "Key" || signer.hash !== datum.recoveryAdmin)) throw new Error("Connect the configured team recovery wallet for partial recovery.");

        const fractionUnit = datum.ftPolicy + datum.ftName;
        const fractionPolicy = { type: "PlutusV3" as const, script: applyParamsToScript(blueprint.ftCompiledCode, [datum.seed as import("@lucid-evolution/lucid").Data, vaultScriptHash]) };
        const derivedPolicyId = mintingPolicyToId(fractionPolicy);
        if (derivedPolicyId !== datum.ftPolicy) throw new Error("The vault seed does not reconstruct its fraction policy.");

        const tx = await lucid.newTx()
          .collectFrom([vaultUtxo], Data.to(new Constr(mode === "combine" ? 0 : 1, mode === "combine" ? [] : [burnAmount])))
          .mintAssets({ [fractionUnit]: -burnAmount }, Data.to(new Constr(1, [datum.ftName])))
          .attach.SpendingValidator(vaultValidator)
          .attach.MintingPolicy(fractionPolicy)
          .pay.ToAddress(mode === "combine" ? walletAddress : datum.owner, { [datum.nftUnit]: BigInt(1) })
          .addSigner(walletAddress)
          .complete();
        const txHash = await (await tx.sign.withWallet().complete()).submit();
        setMessage((mode === "combine" ? "Combine" : "Partial recovery") + " submitted: " + txHash + ". The fractions were burned and the original asset was returned to " + (mode === "combine" ? "this wallet." : "the recorded owner."));
        setSelectedUnit("");
        setFractionCount("");
        return;
      }

      const source = (await lucid.utxosAt(walletAddress)).find((utxo) => (utxo.assets[selectedAsset.unit] || BigInt(0)) >= BigInt(1));
      if (!source) throw new Error("The selected asset is no longer in the connected wallet.");

      const fractionTotal = BigInt(fractionCount);
      const seed = new Constr(0, [source.txHash, BigInt(source.outputIndex)]);
      const fractionPolicy = { type: "PlutusV3" as const, script: applyParamsToScript(blueprint.ftCompiledCode, [seed, vaultScriptHash]) };
      const fractionPolicyId = mintingPolicyToId(fractionPolicy);
      const fractionName = fromText(utf8TokenName(selectedAsset.name));
      const fractionUnit = fractionPolicyId + fractionName;
      const paymentCredential = getAddressDetails(walletAddress).paymentCredential;
      if (!paymentCredential || paymentCredential.type !== "Key") throw new Error("The connected wallet has no payment key credential.");
      if (!blueprint.recoveryAdmin || !/^[0-9a-f]{56}$/.test(blueprint.recoveryAdmin)) throw new Error("Configure NEXT_PUBLIC_TEAM_KEY_HASH before fractionalizing assets.");
      const details = getAddressDetails(walletAddress);
      const credential = (item: NonNullable<typeof details.paymentCredential>) => item.type === "Key" ? { PubKeyCredential: [item.hash] } : { ScriptCredential: [item.hash] };
      const ownerData = Data.from(Data.to({ addressCredential: credential(details.paymentCredential!), addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null } as never, tools.AddressSchema as never));
      const vaultDatum = new Constr(0, [ownerData, blueprint.recoveryAdmin, selectedAsset.unit.slice(0, 56), selectedAsset.unit.slice(56), fractionPolicyId, fractionName, fractionTotal, seed]);
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
  const assetPlaceholder = !address ? "Connect Eternl first" : mode !== "split" && !lucid ? "Connect Eternl first" : assetStatus === "loading" ? "Loading vault assets…" : assets.length ? mode !== "split" ? "Choose a locked asset" : "Choose an asset" : mode !== "split" ? "No assets locked in vaults" : "No native assets found";
  const assetHint = mode !== "split" ? "Assets are read from active recovery vaults." : "Assets are read from the connected wallet.";
  const tokenToReceive = selectedAsset ? selectedAsset.name + " fractions" : "";
  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">01 / Position setup</span><h2>{mode === "split" ? "Create fractional ownership" : mode === "combine" ? "Combine your fractional units" : "Recover with missing fractions"}</h2></div><span className="step-badge">1 of 2</span></div><div className="segmented-control"><button type="button" className={mode === "split" ? "selected" : ""} onClick={() => changeMode("split")}>Fractionalize</button><button type="button" className={mode === "combine" ? "selected" : ""} onClick={() => changeMode("combine")}>Combine</button><button type="button" className={mode === "recover" ? "selected" : ""} onClick={() => changeMode("recover")}>Team recovery</button></div><div className="field-grid"><Field label="Select RWA asset" placeholder={assetPlaceholder} hint={assetHint} select options={assetOptions} value={selectedUnit} onChange={(value) => { setSelectedUnit(value); setMessage(null); setError(null); }} disabled={!address || assetStatus === "loading" || assets.length === 0} /><Field label={mode === "split" ? "Number of fractions" : mode === "combine" ? "Full fraction supply" : "Available fractions to burn"} placeholder={mode === "split" ? "e.g. 1,000" : mode === "combine" ? selectedAsset?.requiredFractions || "Full supply" : "Fewer than full supply"} value={fractionCount} onChange={(value) => { setFractionCount(value); setMessage(null); setError(null); }} /><Field label="Token you receive" placeholder="Created automatically" value={mode === "split" ? tokenToReceive : "Original RWA token"} hint={mode === "recover" ? "Emergency recovery sends the NFT only to its recorded original owner." : "A fungible token represents fractional ownership."} readOnly /><Field label={mode === "recover" ? "Recorded owner" : "Recipient wallet"} placeholder="Connect Eternl first" value={mode === "recover" ? selectedAsset?.owner || "" : address} hint={mode === "recover" ? "The connected team recovery wallet authorizes this action." : "Assets are sent to the connected wallet."} readOnly /></div>{selectedAsset && <div className="asset-selection-note"><span>Selected asset name (UTF-8)</span><strong>{selectedAsset.name}</strong><code>{selectedAsset.unit}</code></div>}{error && <p className="form-message error-message" role="alert">{error}</p>}{message && <p className="form-message success-message" role="status">{message}</p>}<div className="calculation-card"><span>{mode === "split" ? "Fractionalization preview" : mode === "combine" ? "Combination preview" : "Emergency recovery preview"}</span><strong>{selectedAsset ? selectedAsset.name + " → " + fractionCount + " ownership units" : "Select an asset and enter a fraction amount"}</strong><p>{mode === "split" ? "The NFT will be locked in the vault and the newly minted fraction token will be sent to the connected wallet." : mode === "combine" ? "The full fraction supply will be burned and the original NFT will be returned to this wallet." : "The team recovery key must sign, the available fractions are burned, and the original NFT returns only to the owner recorded in the vault. Remaining tokens become non-redeemable and must be delisted."}</p></div><div className="form-footer"><p><span className="status-dot" /> {submitting ? "Awaiting Eternl signature…" : "Ready for review and signing."}</p><button type="button" className="primary-button" onClick={() => void reviewFractions()} disabled={submitting}>{submitting ? "Building transaction…" : mode === "split" ? "Review & fractionalize" : mode === "combine" ? "Review & combine" : "Authorize recovery"} <Arrow /></button></div></section>;
}
