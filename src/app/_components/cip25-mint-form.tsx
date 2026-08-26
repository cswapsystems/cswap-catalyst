"use client";

import { FormEvent, useState } from "react";

type FormState = { name: string; tokenName: string; image: string; mediaType: string; description: string };

const initialState: FormState = { name: "", tokenName: "", image: "ipfs://", mediaType: "image/png", description: "" };

function metadataText(value: string): string | string[] {
  const chunks: string[] = [];
  let chunk = "";

  for (const character of value) {
    if (new TextEncoder().encode(chunk + character).length > 64) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk += character;
    }
  }
  if (chunk) chunks.push(chunk);

  return chunks.length === 1 ? chunks[0] : chunks;
}

export default function Cip25MintForm() {
  const [form, setForm] = useState(initialState);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field: keyof FormState, value: string) { setForm((current) => ({ ...current, [field]: value })); }

  async function mint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null); setStatus(null);
    if (!window.cardano?.eternl) { setError("Install Eternl, import the admin demo wallet, and switch it to Preprod."); return; }
    if (!form.name.trim() || !form.tokenName.trim() || !form.image.trim() || !form.description.trim()) { setError("Name, token name, image URI, and description are required for CIP-25 metadata."); return; }
    if (new TextEncoder().encode(form.tokenName).length > 32) { setError("Token name must be at most 32 UTF-8 bytes."); return; }
    if (new TextEncoder().encode(form.name.trim()).length > 64) { setError("Display name must be at most 64 UTF-8 bytes."); return; }
    if (!form.image.startsWith("ipfs://") && !form.image.startsWith("https://")) { setError("Use an ipfs:// or https:// image URI."); return; }
    setSubmitting(true);
    try {
      const api = await window.cardano.eternl.enable();
      if (await api.getNetworkId() !== 0) throw new Error("Eternl must be set to Cardano Preprod.");
      const { Blockfrost, Constr, Data, Lucid, applyParamsToScript, fromText, mintingPolicyToId } = await import("@lucid-evolution/lucid");
      const policyResponse = await fetch("/api/minter-blueprint", { cache: "no-store" });
      if (!policyResponse.ok) throw new Error("Unable to load the minter policy.");
      const { compiledCode }: { compiledCode: string } = await policyResponse.json();
      const lucid = await Lucid(new Blockfrost("/api/blockfrost", ""), "Preprod");
      lucid.selectWallet.fromAPI(api);
      const address = await lucid.wallet().address();
      const seed = (await lucid.utxosAt(address)).filter((utxo) => Object.keys(utxo.assets).every((unit) => unit === "lovelace") && utxo.assets.lovelace > BigInt(5_000_000)).sort((a, b) => (a.assets.lovelace > b.assets.lovelace ? -1 : 1))[0];
      if (!seed) throw new Error("Connected wallet needs an ADA-only UTxO with at least 5 tADA.");
      const policy = { type: "PlutusV3" as const, script: applyParamsToScript(compiledCode, [new Constr(0, [seed.txHash, BigInt(seed.outputIndex)])]) };
      const policyId = mintingPolicyToId(policy); const assetName = fromText(form.tokenName); const unit = policyId + assetName;
      const cip25 = { [policyId]: { [form.tokenName]: { name: form.name.trim(), image: metadataText(form.image.trim()), mediaType: form.mediaType, description: metadataText(form.description.trim()) } }, version: "1.0" };
      const tx = await lucid.newTx().collectFrom([seed]).mintAssets({ [unit]: BigInt(1) }, Data.to(new Constr(0, [[assetName]]))).attach.MintingPolicy(policy).attachMetadata(721, cip25).pay.ToAddress(address, { lovelace: BigInt(2_000_000), [unit]: BigInt(1) }).complete();
      const txHash = await (await tx.sign.withWallet().complete()).submit();
      setStatus(`Mint submitted: ${txHash}`);
      setForm(initialState);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Minting was cancelled or failed."); }
    finally { setSubmitting(false); }
  }

  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">CIP-25 / Label 721</span><h2>Mint a documented RWA NFT</h2></div><span className="step-badge">Preprod</span></div><p className="mint-intro">Eternl signs a one-shot NFT mint. Its CIP-25 metadata is embedded in the same transaction, preserving the asset-to-metadata provenance link.</p><form onSubmit={mint} className="mint-contract-form"><div className="field-grid"><label className="field"><span className="field-label">Display name</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="e.g. Northline Solar Project" /></label><label className="field"><span className="field-label">Token name</span><input value={form.tokenName} onChange={(event) => update("tokenName", event.target.value)} placeholder="e.g. NLS-001" /><span className="field-hint">Max. 32 UTF-8 bytes; used as the native asset name.</span></label><label className="field"><span className="field-label">Image URI</span><input value={form.image} onChange={(event) => update("image", event.target.value)} placeholder="ipfs://…" /></label><label className="field"><span className="field-label">Media type</span><select value={form.mediaType} onChange={(event) => update("mediaType", event.target.value)}><option>image/png</option><option>image/jpeg</option><option>image/webp</option></select></label></div><label className="field description-field"><span className="field-label">Description</span><textarea value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="Describe the represented real-world asset and its verification context." maxLength={500} /></label>{error && <p className="form-message error-message">{error}</p>}{status && <p className="form-message success-message">{status}</p>}<div className="form-footer"><p><span className="status-dot" /> Uses the minter&apos;s one-shot multi-NFT policy.</p><button type="submit" className="primary-button" disabled={submitting}>{submitting ? "Awaiting Eternl…" : "Mint with Eternl"} <span className="button-arrow">↗</span></button></div></form></section>;
}
