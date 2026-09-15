"use client";

import { FormEvent, RefObject, useRef, useState } from "react";
import { buildRwaManifest, buildRwaManifestPreview, initialRwaMetadataInput, RwaMetadataInput, validateRwaMetadata } from "@/lib/rwa-metadata";
import { useWallet } from "./wallet-context";

type UploadKind = "image" | "proof" | "metadata";
type MediaType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "application/json";
type IpfsUpload = { uri: string; mediaType: MediaType };

function metadataText(value: string): string | string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (new TextEncoder().encode(chunk + character).length > 64) {
      chunks.push(chunk);
      chunk = character;
    } else chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length === 1 ? chunks[0] : chunks;
}

async function uploadAssetFile(file: File, kind: UploadKind): Promise<IpfsUpload> {
  const body = new FormData();
  body.set("file", file);
  body.set("kind", kind);
  const response = await fetch("/api/ipfs/upload", { method: "POST", body });
  const payload = await response.json().catch(() => null) as (IpfsUpload & { error?: string }) | null;
  if (!response.ok || !payload?.uri || !payload.mediaType) throw new Error(payload?.error ?? `Unable to upload the ${kind} file to IPFS.`);
  return payload;
}

function FilePicker({ label, file, accept, help, inputRef, disabled, onSelect }: {
  label: string; file: File | null; accept: string; help: string;
  inputRef: RefObject<HTMLInputElement | null>; disabled: boolean; onSelect: (file: File | null) => void;
}) {
  return <div className="upload-zone">
    <span className="upload-icon" aria-hidden="true">↑</span>
    <div><strong>{file ? file.name : label}</strong><p>{file ? `${(file.size / 1_024 / 1_024).toFixed(2)} MB · verified during upload` : help}</p></div>
    <label className="text-button">{file ? "Replace file" : "Select file"}<input ref={inputRef} className="file-input" type="file" accept={accept} disabled={disabled} required={!file} onChange={(event) => onSelect(event.currentTarget.files?.[0] ?? null)} /></label>
  </div>;
}

function InputField({ label, value, onChange, placeholder, hint, type = "text", inputMode, maxLength, pattern }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; hint?: string;
  type?: "text" | "date" | "number"; inputMode?: "decimal" | "numeric"; maxLength?: number; pattern?: string;
}) {
  return <label className="field"><span className="field-label">{label} <span aria-hidden="true">*</span></span><input required type={type} inputMode={inputMode} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} maxLength={maxLength} pattern={pattern} min={type === "number" ? "0" : undefined} step={type === "number" ? "any" : undefined} />{hint && <span className="field-hint">{hint}</span>}</label>;
}

function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="field"><span className="field-label">{label} <span aria-hidden="true">*</span></span><span className="field-input-wrap"><select required value={value} onChange={(event) => onChange(event.target.value)}><option value="" disabled>Select an option</option>{children}</select><span className="select-chevron" aria-hidden="true">⌄</span></span></label>;
}

export default function Cip25MintForm() {
  const { connect } = useWallet();
  const [form, setForm] = useState<RwaMetadataInput>(initialRwaMetadataInput);
  const [image, setImage] = useState<File | null>(null);
  const [proof, setProof] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const proofInput = useRef<HTMLInputElement>(null);

  function update(field: keyof RwaMetadataInput, value: string | boolean) {
    setForm((current) => ({ ...current, [field]: value }));
    setError(null);
  }

  function selectFile(setter: (file: File | null) => void, file: File | null) {
    setter(file);
    setError(null);
  }

  async function mint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);
    const validationErrors = validateRwaMetadata(form);
    if (validationErrors.length) return setError(validationErrors[0]);
    if (!image || !proof) return setError("An asset image and proof-of-authenticity PDF are required.");
    if (!window.cardano?.eternl) return setError("Install Eternl, import the admin demo wallet, and switch it to Preprod.");

    setSubmitting(true);
    try {
      const lucid = await connect();
      if (!lucid) throw new Error("Unable to connect Eternl. Check the wallet connection message.");
      const uploadedImage = await uploadAssetFile(image, "image");
      const uploadedProof = await uploadAssetFile(proof, "proof");
      const generatedAt = new Date().toISOString();
      const manifest = buildRwaManifest(form, { image: uploadedImage, authenticityProof: uploadedProof }, generatedAt);
      const manifestFile = new File([JSON.stringify(manifest, null, 2)], `${form.tokenName.trim().replace(/[^a-zA-Z0-9_-]/g, "-") || "rwa"}-metadata.json`, { type: "application/json" });
      const uploadedMetadata = await uploadAssetFile(manifestFile, "metadata");
      const { Constr, Data, applyParamsToScript, fromText, mintingPolicyToId } = await import("@lucid-evolution/lucid");
      const policyResponse = await fetch("/api/minter-blueprint", { cache: "no-store" });
      if (!policyResponse.ok) throw new Error("Unable to load the minter policy.");
      const { compiledCode }: { compiledCode: string } = await policyResponse.json();
      const address = await lucid.wallet().address();
      const seed = (await lucid.utxosAt(address))
        .filter((utxo) => Object.keys(utxo.assets).every((unit) => unit === "lovelace") && utxo.assets.lovelace > BigInt(5_000_000))
        .sort((a, b) => (a.assets.lovelace > b.assets.lovelace ? -1 : 1))[0];
      if (!seed) throw new Error("Connected wallet needs an ADA-only UTxO with at least 5 tADA.");
      const policy = { type: "PlutusV3" as const, script: applyParamsToScript(compiledCode, [new Constr(0, [seed.txHash, BigInt(seed.outputIndex)])]) };
      const policyId = mintingPolicyToId(policy);
      const assetName = fromText(form.tokenName.trim());
      const unit = policyId + assetName;
      const cip25 = {
        [policyId]: { [form.tokenName.trim()]: {
          name: form.name.trim(), image: metadataText(uploadedImage.uri), mediaType: uploadedImage.mediaType,
          description: metadataText(form.description.trim()), rwaCategory: form.category, rwaManifest: metadataText(uploadedMetadata.uri),
          files: [
            { name: "Proof of authenticity", mediaType: uploadedProof.mediaType, src: metadataText(uploadedProof.uri) },
            { name: "RWA metadata manifest", mediaType: uploadedMetadata.mediaType, src: metadataText(uploadedMetadata.uri) },
          ],
        } }, version: "1.0",
      };
      const tx = await lucid.newTx().collectFrom([seed]).mintAssets({ [unit]: BigInt(1) }, Data.to(new Constr(0, [[assetName]]))).attach.MintingPolicy(policy).attachMetadata(721, cip25).pay.ToAddress(address, { lovelace: BigInt(2_000_000), [unit]: BigInt(1) }).complete();
      const txHash = await (await tx.sign.withWallet().complete()).submit();
      setStatus(`Image, authenticity proof, and generated ${form.category} manifest pinned to IPFS. Mint submitted: ${txHash}`);
      setForm(initialRwaMetadataInput);
      setImage(null);
      setProof(null);
      [imageInput, proofInput].forEach((input) => { if (input.current) input.current.value = ""; });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Minting was cancelled or failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const preview = buildRwaManifestPreview(form);
  return <section className="work-card form-card">
    <div className="section-heading"><div><span className="section-kicker">CIP-25 / RWA issuance</span><h2>Mint a documented RWA NFT</h2></div><span className="step-badge">Preprod</span></div>
    <p className="mint-intro">Create a structured public record for a Real Estate or Collectible asset. The app generates the JSON manifest and pins it with the image and authenticity document before Eternl signs the one-shot mint.</p>
    <form onSubmit={mint} className="mint-contract-form">
      <fieldset className="mint-form-section"><legend>1. Asset classification</legend><p>Choose the RWA category first. Fields marked * are required.</p><div className="field-grid">
        <SelectField label="Category" value={form.category} onChange={(value) => update("category", value)}><option value="real-estate">Real Estate</option><option value="collectible">Collectibles</option></SelectField>
        <InputField label="Public asset reference" value={form.externalId} onChange={(value) => update("externalId", value)} placeholder="e.g. PROP-2026-001" maxLength={80} hint="Your issuer or catalogue reference; this is public." />
        <InputField label="Display name" value={form.name} onChange={(value) => update("name", value)} placeholder="e.g. Harbor View Unit 12" maxLength={64} />
        <InputField label="Token name" value={form.tokenName} onChange={(value) => update("tokenName", value)} placeholder="e.g. HVU-012" hint="Maximum 32 UTF-8 bytes; used as the native asset name." />
      </div></fieldset>

      {form.category && <fieldset className="mint-form-section"><legend>2. {form.category === "real-estate" ? "Property details" : "Collectible details"}</legend><div className="field-grid">
        {form.category === "real-estate" ? <>
          <SelectField label="Property type" value={form.propertyType} onChange={(value) => update("propertyType", value)}><option value="residential">Residential</option><option value="commercial">Commercial</option><option value="industrial">Industrial</option><option value="land">Land</option><option value="mixed-use">Mixed use</option></SelectField>
          <InputField label="Public property location" value={form.propertyAddress} onChange={(value) => update("propertyAddress", value)} placeholder="City, region, country or approved address" maxLength={160} />
          <InputField label="Title or parcel reference" value={form.titleReference} onChange={(value) => update("titleReference", value)} placeholder="e.g. TCT-123456" maxLength={100} />
          <InputField label="Property area" value={form.area} onChange={(value) => update("area", value)} placeholder="e.g. 125.5" type="number" inputMode="decimal" />
          <SelectField label="Area unit" value={form.areaUnit} onChange={(value) => update("areaUnit", value)}><option value="sqm">Square metres (sqm)</option><option value="sqft">Square feet (sqft)</option><option value="hectare">Hectares</option><option value="acre">Acres</option></SelectField>
        </> : <>
          <SelectField label="Collectible type" value={form.collectibleType} onChange={(value) => update("collectibleType", value)}><option value="artwork">Artwork</option><option value="watch">Watch</option><option value="vehicle">Vehicle</option><option value="memorabilia">Memorabilia</option><option value="other">Other</option></SelectField>
          <InputField label="Maker or creator" value={form.creator} onChange={(value) => update("creator", value)} placeholder="Artist, maker, or manufacturer" maxLength={120} />
          <InputField label="Production year" value={form.productionYear} onChange={(value) => update("productionYear", value)} placeholder="e.g. 1998" inputMode="numeric" pattern="[0-9]{4}" />
          <InputField label="Serial or catalogue number" value={form.serialNumber} onChange={(value) => update("serialNumber", value)} placeholder="e.g. CAT-4471" maxLength={100} />
          <SelectField label="Condition" value={form.condition} onChange={(value) => update("condition", value)}><option value="mint">Mint</option><option value="excellent">Excellent</option><option value="good">Good</option><option value="fair">Fair</option><option value="restored">Restored</option></SelectField>
        </>}
      </div></fieldset>}

      <fieldset className="mint-form-section"><legend>{form.category ? "3" : "2"}. Issuer and valuation</legend><div className="field-grid">
        <InputField label="Issuer legal name" value={form.issuerName} onChange={(value) => update("issuerName", value)} placeholder="e.g. Catalyst Asset Services Ltd." maxLength={120} />
        <InputField label="Issuer country" value={form.issuerCountry} onChange={(value) => update("issuerCountry", value.toUpperCase())} placeholder="e.g. PH" pattern="[A-Za-z]{2}" maxLength={2} hint="Two-letter ISO country code." />
        <InputField label="Valuation amount" value={form.valuationAmount} onChange={(value) => update("valuationAmount", value)} placeholder="e.g. 250000" type="number" inputMode="decimal" />
        <InputField label="Valuation currency" value={form.valuationCurrency} onChange={(value) => update("valuationCurrency", value.toUpperCase())} placeholder="e.g. USD" pattern="[A-Za-z]{3}" maxLength={3} hint="Three-letter ISO currency code." />
        <InputField label="Valuation date" value={form.valuationDate} onChange={(value) => update("valuationDate", value)} type="date" />
      </div></fieldset>

      <fieldset className="mint-form-section"><legend>{form.category ? "4" : "3"}. Public evidence</legend><p>Do not upload KYC records, personal data, confidential contracts, or unredacted private information. IPFS records are public and cannot be reliably withdrawn.</p><div className="upload-list">
        <FilePicker label="Upload asset image" file={image} accept="image/png,image/jpeg,image/webp" help="PNG, JPEG, or WebP up to 5 MB." inputRef={imageInput} disabled={submitting} onSelect={(file) => selectFile(setImage, file)} />
        <FilePicker label="Upload proof of authenticity" file={proof} accept="application/pdf,.pdf" help="Public PDF up to 5 MB, such as a redacted title record, certificate, or signed attestation." inputRef={proofInput} disabled={submitting} onSelect={(file) => selectFile(setProof, file)} />
      </div></fieldset>

      <label className="field description-field"><span className="field-label">Public asset description *</span><textarea required value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="Describe the represented asset, ownership claim, verification context, and material limitations." minLength={20} maxLength={500} /><span className="field-hint">20–500 characters. This description is included in CIP-25 metadata.</span></label>
      <label className="public-data-confirmation"><input type="checkbox" required checked={form.publicDataConfirmed} onChange={(event) => update("publicDataConfirmed", event.target.checked)} /><span>I confirm that I am authorized to submit this asset record and that all entered information and uploaded documents are approved for permanent public storage.</span></label>
      <details className="metadata-template"><summary>Preview generated JSON metadata template</summary><p>The final file replaces the placeholder IPFS URIs after both uploads complete.</p><pre>{JSON.stringify(preview, null, 2)}</pre></details>
      {error && <p className="form-message error-message" role="alert">{error}</p>}
      {status && <p className="form-message success-message" role="status">{status}</p>}
      <div className="form-footer"><p><span className="status-dot" /> Structured manifest schema: cswap.rwa-manifest/v1</p><button type="submit" className="primary-button" disabled={submitting}>{submitting ? "Uploading & awaiting Eternl…" : "Review and mint"} <span className="button-arrow">↗</span></button></div>
    </form>
  </section>;
}
