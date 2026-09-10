"use client";

import { FormEvent, RefObject, useRef, useState } from "react";
import { useWallet } from "./wallet-context";

type FormState = { name: string; tokenName: string; description: string };
type UploadKind = "image" | "proof" | "metadata";
type MediaType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "application/json";
type IpfsUpload = { uri: string; mediaType: MediaType };

const initialState: FormState = { name: "", tokenName: "", description: "" };

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

async function uploadAssetFile(file: File, kind: UploadKind): Promise<IpfsUpload> {
  const body = new FormData();
  body.set("file", file);
  body.set("kind", kind);

  const response = await fetch("/api/ipfs/upload", { method: "POST", body });
  const payload = await response.json().catch(() => null) as (IpfsUpload & { error?: string }) | null;
  if (!response.ok || !payload?.uri || !payload.mediaType) {
    throw new Error(payload?.error ?? `Unable to upload the ${kind} file to IPFS.`);
  }

  return payload;
}

function FilePicker({ label, file, accept, help, inputRef, disabled, onSelect }: {
  label: string;
  file: File | null;
  accept: string;
  help: string;
  inputRef: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  onSelect: (file: File | null) => void;
}) {
  return <div className="upload-zone"><span className="upload-icon" aria-hidden="true">↑</span><div><strong>{file ? file.name : label}</strong><p>{file ? `${(file.size / 1_024 / 1_024).toFixed(2)} MB · verified during upload` : help}</p></div><label className="text-button">{file ? "Replace file" : "Select file"}<input ref={inputRef} className="file-input" type="file" accept={accept} disabled={disabled} onChange={(event) => onSelect(event.currentTarget.files?.[0] ?? null)} /></label></div>;
}

export default function Cip25MintForm() {
  const { connect } = useWallet();
  const [form, setForm] = useState(initialState);
  const [image, setImage] = useState<File | null>(null);
  const [proof, setProof] = useState<File | null>(null);
  const [metadataFile, setMetadataFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const proofInput = useRef<HTMLInputElement>(null);
  const metadataInput = useRef<HTMLInputElement>(null);

  function update(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectFile(setter: (file: File | null) => void, file: File | null) {
    setter(file);
    setError(null);
  }

  async function mint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);

    if (!window.cardano?.eternl) {
      setError("Install Eternl, import the admin demo wallet, and switch it to Preprod.");
      return;
    }
    if (!form.name.trim() || !form.tokenName.trim() || !form.description.trim() || !image || !proof || !metadataFile) {
      setError("Name, token name, image, proof-of-authenticity PDF, JSON metadata, and description are required.");
      return;
    }
    if (new TextEncoder().encode(form.tokenName).length > 32) {
      setError("Token name must be at most 32 UTF-8 bytes.");
      return;
    }
    if (new TextEncoder().encode(form.name.trim()).length > 64) {
      setError("Display name must be at most 64 UTF-8 bytes.");
      return;
    }

    setSubmitting(true);
    try {
      const lucid = await connect();
      if (!lucid) throw new Error("Unable to connect Eternl. Check the wallet connection message.");

      const uploadedImage = await uploadAssetFile(image, "image");
      const uploadedProof = await uploadAssetFile(proof, "proof");
      const uploadedMetadata = await uploadAssetFile(metadataFile, "metadata");
      const { Constr, Data, applyParamsToScript, fromText, mintingPolicyToId } = await import("@lucid-evolution/lucid");
      const policyResponse = await fetch("/api/minter-blueprint", { cache: "no-store" });
      if (!policyResponse.ok) throw new Error("Unable to load the minter policy.");

      const { compiledCode }: { compiledCode: string } = await policyResponse.json();
      const address = await lucid.wallet().address();
      const seed = (await lucid.utxosAt(address))
        .filter((utxo) => Object.keys(utxo.assets).every((unit) => unit === "lovelace") && utxo.assets.lovelace > BigInt(5_000_000))
        .sort((a, b) => (a.assets.lovelace > b.assets.lovelace ? -1 : 1))[0];
      if (!seed) throw new Error("Connected wallet needs an ADA-only UTxO with at least 5 tADA.");

      const policy = {
        type: "PlutusV3" as const,
        script: applyParamsToScript(compiledCode, [new Constr(0, [seed.txHash, BigInt(seed.outputIndex)])]),
      };
      const policyId = mintingPolicyToId(policy);
      const assetName = fromText(form.tokenName);
      const unit = policyId + assetName;
      const cip25 = {
        [policyId]: {
          [form.tokenName]: {
            name: form.name.trim(),
            image: metadataText(uploadedImage.uri),
            mediaType: uploadedImage.mediaType,
            description: metadataText(form.description.trim()),
            files: [
              { name: "Proof of authenticity", mediaType: uploadedProof.mediaType, src: metadataText(uploadedProof.uri) },
              { name: "Asset metadata", mediaType: uploadedMetadata.mediaType, src: metadataText(uploadedMetadata.uri) },
            ],
          },
        },
        version: "1.0",
      };
      const tx = await lucid.newTx()
        .collectFrom([seed])
        .mintAssets({ [unit]: BigInt(1) }, Data.to(new Constr(0, [[assetName]])))
        .attach.MintingPolicy(policy)
        .attachMetadata(721, cip25)
        .pay.ToAddress(address, { lovelace: BigInt(2_000_000), [unit]: BigInt(1) })
        .complete();
      const txHash = await (await tx.sign.withWallet().complete()).submit();
      setStatus(`Image, authenticity proof, and metadata JSON pinned to IPFS. Mint submitted: ${txHash}`);
      setForm(initialState);
      setImage(null);
      setProof(null);
      setMetadataFile(null);
      [imageInput, proofInput, metadataInput].forEach((input) => { if (input.current) input.current.value = ""; });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Minting was cancelled or failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">CIP-25 / Label 721</span><h2>Mint a documented RWA NFT</h2></div><span className="step-badge">Preprod</span></div><p className="mint-intro">Eternl signs a one-shot NFT mint. The asset image, proof-of-authenticity PDF, and JSON metadata are pinned to IPFS; their immutable URIs are embedded in the same CIP-25 record.</p><form onSubmit={mint} className="mint-contract-form"><div className="field-grid"><label className="field"><span className="field-label">Display name</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="e.g. Northline Solar Project" /></label><label className="field"><span className="field-label">Token name</span><input value={form.tokenName} onChange={(event) => update("tokenName", event.target.value)} placeholder="e.g. NLS-001" /><span className="field-hint">Max. 32 UTF-8 bytes; used as the native asset name.</span></label></div><div className="upload-list"><FilePicker label="Upload asset image" file={image} accept="image/png,image/jpeg,image/webp" help="PNG, JPEG, or WebP up to 5 MB." inputRef={imageInput} disabled={submitting} onSelect={(file) => selectFile(setImage, file)} /><FilePicker label="Upload proof of authenticity" file={proof} accept="application/pdf,.pdf" help="PDF up to 5 MB, such as a certificate or signed attestation." inputRef={proofInput} disabled={submitting} onSelect={(file) => selectFile(setProof, file)} /><FilePicker label="Upload asset metadata" file={metadataFile} accept="application/json,.json" help="A valid JSON object up to 5 MB with public asset metadata." inputRef={metadataInput} disabled={submitting} onSelect={(file) => selectFile(setMetadataFile, file)} /></div><label className="field description-field"><span className="field-label">Description</span><textarea value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="Describe the represented real-world asset and its verification context." maxLength={500} /></label>{error && <p className="form-message error-message" role="alert">{error}</p>}{status && <p className="form-message success-message" role="status">{status}</p>}<div className="form-footer"><p><span className="status-dot" /> Uses the minter&apos;s one-shot multi-NFT policy.</p><button type="submit" className="primary-button" disabled={submitting}>{submitting ? "Uploading & awaiting Eternl…" : "Mint with Eternl"} <span className="button-arrow">↗</span></button></div></form></section>;
}
