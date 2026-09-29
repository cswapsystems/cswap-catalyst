"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatAda } from "@/lib/ada";
import { readRegistry, registryConfigured } from "@/lib/asset-registry";

type JsonRecord = Record<string, unknown>;
type AssetDetails = { asset: string; policy_id: string; asset_name: string; fingerprint?: string; quantity?: string; initial_mint_tx_hash?: string; mint_or_burn_count?: number; onchain_metadata?: unknown; onchain_metadata_standard?: string };
type TransactionDetails = { block_time?: number; block?: string; fees?: string };
type AssociatedFile = { name: string; mediaType?: string; src: string };
type AssetMetadata = JsonRecord & { name?: unknown; image?: unknown; mediaType?: unknown; description?: unknown; files?: unknown };
type BrowserState = { details: AssetDetails; metadata: AssetMetadata | null; transaction: TransactionDetails | null; registration: string };

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asText(value: unknown): string { return typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join("") : ""; }
function hexToText(hex: string): string {
  if (!hex || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return "";
  try { return new TextDecoder().decode(Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))); } catch { return ""; }
}
function normalizeAssetId(value: string): string { return value.trim().replace(/\s+/g, "").replace(".", "").toLowerCase(); }
function isAssetId(value: string): boolean { return /^[0-9a-f]{56,120}$/.test(value); }

function metadataEntry(value: unknown, policyId: string, tokenNameHex: string): AssetMetadata | null {
  const tokenKeys = new Set([tokenNameHex, hexToText(tokenNameHex)].filter(Boolean));
  function walk(node: unknown): AssetMetadata | null {
    if (!isRecord(node)) return null;
    const policyNode = Object.entries(node).find(([key, child]) => key.toLowerCase() === policyId && isRecord(child));
    if (policyNode && isRecord(policyNode[1])) {
      const tokenNode = Object.entries(policyNode[1]).find(([key, child]) => tokenKeys.has(key) && isRecord(child));
      if (tokenNode && isRecord(tokenNode[1])) return tokenNode[1] as AssetMetadata;
    }
    if ("image" in node || "files" in node || "description" in node || "name" in node) return node as AssetMetadata;
    for (const child of Object.values(node)) { const found = walk(child); if (found) return found; }
    return null;
  }
  return walk(value);
}
function findMetadata(sources: unknown[], policyId: string, tokenNameHex: string): AssetMetadata | null { for (const source of sources) { const found = metadataEntry(source, policyId, tokenNameHex); if (found) return found; } return null; }
function validFileUri(value: string): boolean { return /^(?:https?:\/\/|ipfs:\/\/|ar:\/\/)/i.test(value); }
function gatewayUrl(value: string): string | null {
  if (!validFileUri(value)) return null;
  if (value.toLowerCase().startsWith("ipfs://")) {
    const cid = value.slice(7).replace(/^ipfs\//i, "").split("/")[0];
    return /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(cid) ? "/api/ipfs/gateway/" + cid : null;
  }
  if (value.toLowerCase().startsWith("ar://")) return `https://arweave.net/${value.slice(5)}`;
  return value;
}
function metadataFiles(metadata: AssetMetadata | null): AssociatedFile[] {
  if (!metadata || !Array.isArray(metadata.files)) return [];
  return metadata.files.flatMap((file, index) => {
    if (!isRecord(file)) return [];
    const src = asText(file.src);
    return src && validFileUri(src) ? [{ name: asText(file.name) || `Associated file ${index + 1}`, mediaType: asText(file.mediaType) || undefined, src }] : [];
  });
}
function formatQuantity(quantity: string | undefined): string { if (!quantity) return "—"; const number = Number(quantity); return Number.isFinite(number) ? new Intl.NumberFormat("en-US").format(number) : quantity; }
function formatDate(timestamp: number | undefined): string { return timestamp ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(timestamp * 1_000) : "—"; }
function explorerUrl(assetId: string): string { const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "preprod" ? "preprod" : "mainnet"; return `https://${network === "preprod" ? "preprod." : ""}cexplorer.io/asset/${assetId}`; }
function transactionUrl(hash: string): string { const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "preprod" ? "preprod" : "mainnet"; return `https://${network === "preprod" ? "preprod." : ""}cexplorer.io/tx/${hash}`; }
async function readJson(response: Response): Promise<unknown> { return response.json().catch(() => null); }

async function loadAsset(assetId: string): Promise<BrowserState> {
  const assetResponse = await fetch(`/api/blockfrost/assets/${assetId}`, { cache: "no-store" });
  const assetPayload = await readJson(assetResponse);
  if (!assetResponse.ok || !isRecord(assetPayload) || typeof assetPayload.asset !== "string") {
    const message = isRecord(assetPayload) && typeof assetPayload.error === "string" ? assetPayload.error : "Asset was not found on the selected network.";
    throw new Error(message);
  }
  const details = assetPayload as unknown as AssetDetails;
  const metadataResponse = await fetch(`/api/blockfrost/assets/${assetId}/metadata`, { cache: "no-store" });
  const metadataPayload = metadataResponse.ok ? await readJson(metadataResponse) : null;
  let transaction: TransactionDetails | null = null;
  let transactionMetadata: unknown = null;
  if (details.initial_mint_tx_hash) {
    const [transactionResponse, txMetadataResponse] = await Promise.all([
      fetch(`/api/blockfrost/txs/${details.initial_mint_tx_hash}`, { cache: "no-store" }),
      fetch(`/api/blockfrost/txs/${details.initial_mint_tx_hash}/metadata`, { cache: "no-store" }),
    ]);
    transaction = transactionResponse.ok ? await readJson(transactionResponse) as TransactionDetails : null;
    transactionMetadata = txMetadataResponse.ok ? await readJson(txMetadataResponse) : null;
  }
  let registration = "Registry not configured";
  if (registryConfigured) {
    try { registration = (await readRegistry()).entries.includes(assetId) ? "CSWAP registered" : "Not registered with CSWAP"; }
    catch { registration = "Registry verification unavailable"; }
  }
  return { registration, details, metadata: findMetadata([transactionMetadata, metadataPayload, details.onchain_metadata], details.policy_id, details.asset_name), transaction };
}

export default function AssetBrowser({ initialAssetId }: { initialAssetId: string }) {
  const requestedAssetId = normalizeAssetId(initialAssetId);
  const [assetId, setAssetId] = useState(requestedAssetId);
  const [state, setState] = useState<BrowserState | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(isAssetId(requestedAssetId) ? "loading" : "idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAssetId(requestedAssetId)) return;
    let cancelled = false;
    void loadAsset(requestedAssetId).then((result) => { if (!cancelled) { setState(result); setStatus("ready"); } }).catch((cause) => { if (!cancelled) { setStatus("error"); setError(cause instanceof Error ? cause.message : "Unable to load this asset."); } });
    return () => { cancelled = true; };
  }, [requestedAssetId]);

  async function lookup(value = assetId) {
    const normalized = normalizeAssetId(value);
    setAssetId(normalized); setError(null); setState(null);
    if (!isAssetId(normalized)) { setStatus("error"); setError("Enter a valid asset ID: 56-character policy ID followed by up to 64 hex characters of asset name."); return; }
    setStatus("loading");
    try { setState(await loadAsset(normalized)); setStatus("ready"); window.history.replaceState(null, "", `/assets?asset=${normalized}`); } catch (cause) { setStatus("error"); setError(cause instanceof Error ? cause.message : "Unable to load this asset."); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void lookup(); }

  const files = useMemo(() => metadataFiles(state?.metadata ?? null), [state?.metadata]);
  const displayName = asText(state?.metadata?.name) || (state ? hexToText(state.details.asset_name) || "Untitled asset" : "");
  const description = asText(state?.metadata?.description);
  const imageUrl = gatewayUrl(asText(state?.metadata?.image));
  const metadataJson = state?.metadata ? JSON.stringify(state.metadata, null, 2) : "";

  return <section className="asset-browser"><div className="asset-browser-head"><div><span className="section-kicker">CIP-25 asset lookup</span><h2>See the record behind a token</h2><Link href="/asset-registry">Browse approved assets ↗</Link><p className="directory-intro">Paste a Cardano asset ID to inspect its current supply, mint history, on-chain metadata, and the files pinned when it was created.</p></div><span className="network-badge"><i /> {process.env.NEXT_PUBLIC_CARDANO_NETWORK === "preprod" ? "Preprod" : "Mainnet"}</span></div>
    <form className="asset-search" onSubmit={submit}><label className="field"><span className="field-label">Asset ID</span><input value={assetId} onChange={(event) => setAssetId(event.target.value)} placeholder="Policy ID + asset name in hex" spellCheck={false} autoCapitalize="none" /></label><button className="primary-button" type="submit" disabled={status === "loading"}>{status === "loading" ? "Looking up…" : "Inspect asset"} <span className="button-arrow">↗</span></button></form>
    {error && <p className="form-message error-message" role="alert">{error}</p>}
    {status === "idle" && <div className="asset-empty"><span className="asset-empty-mark">◇</span><strong>Start with a minted asset ID</strong><p>The ID is the 56-character policy ID followed by the token name encoded as hex. Minted assets from this workspace keep their image, proof, and metadata links in the CIP-25 record.</p></div>}
    {state && <div className="asset-result"><div className="asset-identity-card"><div className="asset-visual">{imageUrl ? <img src={imageUrl} alt={displayName} /> : <span>{displayName.slice(0, 2).toUpperCase() || "◇"}</span>}</div><div className="asset-identity-copy"><span className="asset-status"><i /> {state.registration}</span><h3>{displayName}</h3>{description && <p>{description}</p>}<code>{state.details.asset}</code></div><a className="explorer-link" href={explorerUrl(state.details.asset)} target="_blank" rel="noreferrer">Open in Cexplorer <span className="button-arrow">↗</span></a></div>
      <div className="asset-detail-grid"><article className="asset-panel"><div className="asset-panel-heading"><span className="section-kicker">Asset information</span><span className="asset-panel-icon">01</span></div><dl className="asset-facts"><div><dt>Policy ID</dt><dd><code>{state.details.policy_id}</code></dd></div><div><dt>Token name</dt><dd>{hexToText(state.details.asset_name) || "Unnamed / binary"}<small>{state.details.asset_name || "—"}</small></dd></div><div><dt>Current quantity</dt><dd>{formatQuantity(state.details.quantity)}</dd></div><div><dt>Fingerprint</dt><dd><code>{state.details.fingerprint || "—"}</code></dd></div><div><dt>Mint / burn events</dt><dd>{state.details.mint_or_burn_count ?? "—"}</dd></div><div><dt>Metadata standard</dt><dd>{state.details.onchain_metadata_standard || "CIP-25 / label 721"}</dd></div></dl></article><article className="asset-panel"><div className="asset-panel-heading"><span className="section-kicker">Creation record</span><span className="asset-panel-icon">02</span></div><dl className="asset-facts"><div><dt>Minted</dt><dd>{formatDate(state.transaction?.block_time)}</dd></div><div><dt>Initial mint transaction</dt><dd>{state.details.initial_mint_tx_hash ? <a href={transactionUrl(state.details.initial_mint_tx_hash)} target="_blank" rel="noreferrer"><code>{state.details.initial_mint_tx_hash}</code> <span className="button-arrow">↗</span></a> : "—"}</dd></div><div><dt>Block</dt><dd><code>{state.transaction?.block || "—"}</code></dd></div><div><dt>Network fees</dt><dd>{state.transaction?.fees ? formatAda(BigInt(state.transaction.fees)) + " ADA" : "—"}</dd></div></dl></article></div>
      <article className="asset-panel metadata-panel"><div className="asset-panel-heading"><div><span className="section-kicker">CIP-25 metadata</span><h3>Public asset description</h3></div><span className="asset-panel-icon">03</span></div>{state.metadata ? <div className="metadata-content"><div className="metadata-summary"><div><span>Name</span><strong>{displayName}</strong></div><div><span>Media type</span><strong>{asText(state.metadata.mediaType) || "—"}</strong></div><div><span>Files</span><strong>{files.length + (imageUrl ? 1 : 0)}</strong></div></div><details><summary>View raw metadata</summary><pre>{metadataJson}</pre></details></div> : <p className="asset-muted">No CIP-25 metadata was returned for this asset. The asset record itself is still available above.</p>}</article>
      <article className="asset-panel files-panel"><div className="asset-panel-heading"><div><span className="section-kicker">Created during mint</span><h3>Associated files</h3></div><span className="asset-panel-icon">04</span></div>{imageUrl || files.length ? <div className="file-grid">{imageUrl && <a className="file-card file-card-featured" href={imageUrl} target="_blank" rel="noreferrer"><span className="file-preview"><img src={imageUrl} alt="" /></span><span className="file-card-copy"><strong>Asset image</strong><small>{asText(state.metadata?.mediaType) || "image"}</small></span><span className="button-arrow">↗</span></a>}{files.map((file) => { const url = gatewayUrl(file.src); return url ? <a className="file-card" href={url} target="_blank" rel="noreferrer" key={`${file.name}-${file.src}`}><span className="file-type">{file.mediaType?.split("/").pop()?.toUpperCase() || "FILE"}</span><span className="file-card-copy"><strong>{file.name}</strong><small>{file.mediaType || "IPFS file"}</small></span><span className="button-arrow">↗</span></a> : null; })}</div> : <p className="asset-muted">No file references were included in the published metadata.</p>}</article>
    </div>}
  </section>;
}
