"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { UTxO } from "@lucid-evolution/lucid";
import PlatformHeader from "./platform-header";
import { formatAda } from "@/lib/ada";

type DataConstr = { index: number; fields: unknown[] };
type VaultDatum = { owner: string; recoveryAdmin: string; originalUnit: string; fractionUnit: string; totalFractions: bigint; seed: string };
type VaultUtxo = { id: string; utxo: UTxO; datum: VaultDatum | null; error?: string };

const network = "Preprod" as const;
const explorer = "https://preprod.cexplorer.io";

function asConstr(value: unknown, label: string): DataConstr {
  if (typeof value !== "object" || value === null || !("index" in value) || !("fields" in value)) throw new Error("Malformed " + label + ".");
  const candidate = value as { index: unknown; fields: unknown };
  if (typeof candidate.index !== "number" || !Array.isArray(candidate.fields)) throw new Error("Malformed " + label + ".");
  return { index: candidate.index, fields: candidate.fields };
}

function decodeAddress(value: unknown, tools: typeof import("@lucid-evolution/lucid")): string {
  const root = asConstr(value, "vault owner");
  if (root.index !== 0 || root.fields.length !== 2) throw new Error("Malformed vault owner.");
  const credential = (raw: unknown, label: string) => {
    const item = asConstr(raw, label);
    if ((item.index !== 0 && item.index !== 1) || item.fields.length !== 1 || typeof item.fields[0] !== "string") throw new Error("Malformed " + label + ".");
    return { type: item.index === 0 ? "Key" as const : "Script" as const, hash: item.fields[0] };
  };
  const payment = credential(root.fields[0], "vault owner credential");
  if (root.fields[1] === null) return tools.credentialToAddress(network, payment);
  const stake = asConstr(root.fields[1], "vault owner stake option");
  if (stake.index !== 0 || stake.fields.length !== 1) throw new Error("Malformed vault owner stake option.");
  return tools.credentialToAddress(network, payment, credential(asConstr(stake.fields[0], "vault owner stake hash").fields[0], "vault owner stake credential"));
}

function decodeVaultDatum(raw: string, tools: typeof import("@lucid-evolution/lucid")): VaultDatum {
  const root = asConstr(tools.Data.from(raw), "vault");
  if (root.index !== 0 || root.fields.length !== 8 || typeof root.fields[1] !== "string" || typeof root.fields[2] !== "string" || typeof root.fields[3] !== "string" || typeof root.fields[4] !== "string" || typeof root.fields[5] !== "string" || typeof root.fields[6] !== "bigint") throw new Error("Malformed vault datum.");
  const seed = asConstr(root.fields[7], "vault seed");
  if (seed.index !== 0 || seed.fields.length !== 2 || typeof seed.fields[0] !== "string" || typeof seed.fields[1] !== "bigint") throw new Error("Malformed vault seed.");
  return { owner: decodeAddress(root.fields[0], tools), recoveryAdmin: root.fields[1], originalUnit: root.fields[2] + root.fields[3], fractionUnit: root.fields[4] + root.fields[5], totalFractions: root.fields[6], seed: seed.fields[0] + "#" + seed.fields[1].toString() };
}

function short(value: string, start = 16, end = 10) {
  return value.length > start + end ? value.slice(0, start) + "…" + value.slice(-end) : value;
}

function quantity(value: bigint) {
  return new Intl.NumberFormat("en-US").format(value);
}

function assetRows(utxo: UTxO) {
  return Object.entries(utxo.assets).filter(([, amount]) => amount !== BigInt(0)).sort(([left], [right]) => left.localeCompare(right));
}

export default function VaultWorkbench() {
  const [address, setAddress] = useState("");
  const [utxos, setUtxos] = useState<VaultUtxo[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setStatus("loading"); setError("");
    try {
      const [blueprintResponse, tools] = await Promise.all([fetch("/api/fractionalize-blueprint", { cache: "no-store" }), import("@lucid-evolution/lucid")]);
      const blueprint = await blueprintResponse.json() as { vaultCompiledCode?: string; error?: string };
      if (!blueprintResponse.ok || !blueprint.vaultCompiledCode) throw new Error(blueprint.error ?? "Fractionalization vault validator unavailable.");
      const vaultAddress = tools.validatorToAddress(network, { type: "PlutusV3", script: blueprint.vaultCompiledCode });
      const lucid = await tools.Lucid(new tools.Blockfrost("/api/blockfrost", ""), network);
      const discovered = await lucid.utxosAt(vaultAddress);
      setAddress(vaultAddress);
      setUtxos(discovered.map((utxo) => {
        try { return { id: utxo.txHash + "#" + utxo.outputIndex, utxo, datum: utxo.datum ? decodeVaultDatum(utxo.datum, tools) : null, error: utxo.datum ? undefined : "No inline vault datum." }; }
        catch (cause) { return { id: utxo.txHash + "#" + utxo.outputIndex, utxo, datum: null, error: cause instanceof Error ? cause.message : "Unable to decode vault datum." }; }
      }).sort((left, right) => left.id.localeCompare(right.id)));
      setStatus("ready");
    } catch (cause) { setUtxos([]); setAddress(""); setStatus("error"); setError(cause instanceof Error ? cause.message : "Unable to load the fraction vault."); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);

  const active = utxos.filter((entry) => entry.datum).length;
  const lockedAda = utxos.reduce((total, entry) => total + (entry.utxo.assets.lovelace ?? BigInt(0)), BigInt(0));

  return <div className="platform-shell"><PlatformHeader /><main id="main-content" tabIndex={-1} className="page-main"><section className="hero"><div><span className="eyebrow">On-chain custody · Preprod</span><h1>Fraction vault</h1><p>Every UTxO currently held by the fraction-vault validator. Each active vault locks one original RWA NFT while its fraction supply circulates.</p></div></section><section className="vault-board"><div className="vault-board-head"><div><span className="section-kicker">Public script state</span><h2>Vault UTxOs</h2></div><button type="button" className="refresh-button" disabled={status === "loading"} onClick={() => void refresh()}>{status === "loading" ? "Loading…" : "↻ Refresh"}</button></div>{address && <div className="vault-address"><span>Derived vault address</span><code title={address}>{address}</code><a href={explorer + "/address/" + address} target="_blank" rel="noreferrer">Open in Cexplorer ↗</a></div>}{status === "error" && <p role="alert" className="vault-error">{error}</p>}{status === "loading" && <p role="status" className="vault-loading">Reading UTxOs at the vault address…</p>}{status === "ready" && <><dl className="vault-summary"><div><dt>All UTxOs</dt><dd>{utxos.length}</dd></div><div><dt>Decoded active vaults</dt><dd>{active}</dd></div><div><dt>Locked ADA</dt><dd>{formatAda(lockedAda)} <span>ADA</span></dd></div></dl>{utxos.length === 0 ? <div className="vault-empty"><span aria-hidden="true">◇</span><h3>No active vault UTxOs</h3><p>When an RWA is fractionalized, its original NFT will appear here until every required fraction is burned to release it.</p></div> : <div className="vault-utxo-list">{utxos.map((entry) => <article className="vault-utxo-card" key={entry.id}><div className="vault-utxo-head"><div><span className={entry.datum ? "vault-status" : "vault-status unknown"}>{entry.datum ? "Decoded vault" : "Unrecognized UTxO"}</span><h3>{entry.datum ? short(entry.datum.originalUnit) : entry.id}</h3></div><a href={explorer + "/tx/" + entry.utxo.txHash} target="_blank" rel="noreferrer">{short(entry.id, 14, 8)} ↗</a></div>{entry.datum ? <dl className="vault-utxo-details"><div><dt>Original RWA</dt><dd><Link href={"/assets?asset=" + encodeURIComponent(entry.datum.originalUnit)}><code>{entry.datum.originalUnit}</code></Link></dd></div><div><dt>Fraction token</dt><dd><Link href={"/assets?asset=" + encodeURIComponent(entry.datum.fractionUnit)}><code>{entry.datum.fractionUnit}</code></Link></dd></div><div><dt>Total fractions</dt><dd>{quantity(entry.datum.totalFractions)}</dd></div><div><dt>Owner</dt><dd><a href={explorer + "/address/" + entry.datum.owner} target="_blank" rel="noreferrer"><code>{short(entry.datum.owner)}</code></a></dd></div><div><dt>Recovery admin key hash</dt><dd><code>{entry.datum.recoveryAdmin}</code></dd></div><div><dt>Fraction-policy seed</dt><dd><a href={explorer + "/tx/" + entry.datum.seed.slice(0, 64)} target="_blank" rel="noreferrer"><code>{entry.datum.seed}</code></a></dd></div></dl> : <p className="vault-utxo-warning">{entry.error} It remains listed so no UTxO at this validator is hidden.</p>}<div className="vault-contents"><span>UTxO contents</span><ul>{assetRows(entry.utxo).map(([unit, amount]) => <li key={unit}><code>{unit === "lovelace" ? "ADA" : unit}</code><strong>{unit === "lovelace" ? formatAda(amount) : quantity(amount)}</strong></li>)}</ul></div></article>)}</div>}</>}</section></main></div>;
}
