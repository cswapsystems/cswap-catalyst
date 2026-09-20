"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "./wallet-context";
import DexBootstrapWorkbench from "./dex-bootstrap-workbench";

type Tools = typeof import("@lucid-evolution/lucid");
type AssetClass = { policyId: string; assetName: string };
type Deployment = { network: "preprod"; admin: string; factoryToken: string; factoryAddress: string; ammAddress: string; lpPolicyId: string; poolPolicyId: string; bootstrapOfferAddress?: string; transaction: string };
type Scripts = { factoryState: import("@lucid-evolution/lucid").Script; bootstrapOffer: import("@lucid-evolution/lucid").Script; amm: import("@lucid-evolution/lucid").Script; lp: import("@lucid-evolution/lucid").Script; poolFactory: import("@lucid-evolution/lucid").Script };
type Pool = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; raw: import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data>; poolNft: AssetClass; assetA: AssetClass; assetB: AssetClass; lpToken: AssetClass; feeN: bigint; feeD: bigint; reserveA: bigint; reserveB: bigint; liquidity: bigint; poolLovelace: bigint };
type Action = "create" | "swap-a" | "swap-b" | "add" | "remove" | "destroy";

const actions: { id: Action; label: string }[] = [
  { id: "swap-a", label: "Buy fractions" }, { id: "swap-b", label: "Sell fractions" },
  { id: "add", label: "Add liquidity" }, { id: "remove", label: "Remove liquidity" },
  { id: "create", label: "Create pool" }, { id: "destroy", label: "Destroy pool" },
];

function assetData(tools: Tools, asset: AssetClass) { return new tools.Constr(0, [asset.policyId, asset.assetName]); }
function assetUnit(asset: AssetClass) { return asset.policyId ? asset.policyId + asset.assetName : "lovelace"; }
function parseUnit(value: string): AssetClass {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length < 56 || normalized.length % 2 !== 0) throw new Error("The fraction asset unit must be policy ID + asset name in hexadecimal.");
  return { policyId: normalized.slice(0, 56), assetName: normalized.slice(56) };
}
function addressData(tools: Tools, address: string) {
  const details = tools.getAddressDetails(address);
  if (!details.paymentCredential) throw new Error("Address has no payment credential.");
  const credential = (item: { type: "Key" | "Script"; hash: string }) => item.type === "Key" ? { PubKeyCredential: [item.hash] } : { ScriptCredential: [item.hash] };
  return tools.Data.from(tools.Data.to({ addressCredential: credential(details.paymentCredential), addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null } as never, tools.AddressSchema as never));
}
function poolName(id: bigint) { return id.toString(16).padStart(16, "0"); }
function integerSqrt(value: bigint) { if (value < BigInt(0)) throw new Error("Negative square root."); if (value < BigInt(2)) return value; let x = value; let y = (x + BigInt(1)) / BigInt(2); while (y < x) { x = y; y = (x + value / x) / BigInt(2); } return x; }
function gcd(a: bigint, b: bigint) { while (b !== BigInt(0)) { const next = a % b; a = b; b = next; } return a; }
function asConstr(value: unknown, label: string): import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data> {
  if (!(value && typeof value === "object" && "index" in value && "fields" in value && Array.isArray((value as { fields: unknown }).fields))) throw new Error(`Malformed ${label} datum.`);
  return value as import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data>;
}
function asAsset(value: unknown, label: string): AssetClass {
  const item = asConstr(value, label);
  if (item.fields.length !== 2 || typeof item.fields[0] !== "string" || typeof item.fields[1] !== "string") throw new Error(`Malformed ${label}.`);
  return { policyId: item.fields[0], assetName: item.fields[1] };
}
function decodePool(tools: Tools, utxo: import("@lucid-evolution/lucid").UTxO): Pool {
  if (!utxo.datum) throw new Error("Pool datum is missing.");
  const raw = asConstr(tools.Data.from(utxo.datum), "pool");
  if (raw.fields.length !== 10 || !raw.fields.slice(4, 10).every((value) => typeof value === "bigint")) throw new Error("Malformed pool datum.");
  return { id: `${utxo.txHash}#${utxo.outputIndex}`, utxo, raw, poolNft: asAsset(raw.fields[0], "pool NFT"), assetA: asAsset(raw.fields[1], "quote asset"), assetB: asAsset(raw.fields[2], "fraction asset"), lpToken: asAsset(raw.fields[3], "LP token"), feeN: raw.fields[4] as bigint, feeD: raw.fields[5] as bigint, reserveA: raw.fields[6] as bigint, reserveB: raw.fields[7] as bigint, liquidity: raw.fields[8] as bigint, poolLovelace: raw.fields[9] as bigint };
}
function nextDatum(tools: Tools, pool: Pool, reserveA: bigint, reserveB: bigint, liquidity: bigint) {
  return new tools.Constr(0, [pool.raw.fields[0], pool.raw.fields[1], pool.raw.fields[2], pool.raw.fields[3], pool.feeN, pool.feeD, reserveA, reserveB, liquidity, pool.assetA.policyId ? pool.poolLovelace : reserveA]);
}
function poolValue(pool: Pool, reserveA: bigint, reserveB: bigint) {
  return pool.assetA.policyId ? { lovelace: pool.poolLovelace, [assetUnit(pool.assetA)]: reserveA, [assetUnit(pool.assetB)]: reserveB, [assetUnit(pool.poolNft)]: BigInt(1) } : { lovelace: reserveA, [assetUnit(pool.assetB)]: reserveB, [assetUnit(pool.poolNft)]: BigInt(1) };
}
function reservePayout(pool: Pool) {
  return pool.assetA.policyId ? { lovelace: pool.poolLovelace, [assetUnit(pool.assetA)]: pool.reserveA, [assetUnit(pool.assetB)]: pool.reserveB } : { lovelace: pool.reserveA, [assetUnit(pool.assetB)]: pool.reserveB };
}
function displayName(asset: AssetClass) {
  try { const pairs = asset.assetName.match(/.{2}/g) ?? []; return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(pairs, (byte) => Number.parseInt(byte, 16))) || "Fraction token"; }
  catch { return "Fraction token"; }
}
function format(value: bigint) { return new Intl.NumberFormat("en-US").format(value); }

async function loadDex(tools: Tools) {
  const response = await fetch("/api/dex-blueprint", { cache: "no-store" });
  const body = await response.json() as { validators?: Record<string, string>; deployment?: Deployment; error?: string };
  if (!response.ok || !body.validators || !body.deployment) throw new Error(body.error ?? "DEX deployment is unavailable.");
  const deployment = body.deployment;
  const factoryToken = parseUnit(deployment.factoryToken);
  const bootstrapOffer = { type: "PlutusV3" as const, script: body.validators["bootstrap_offer.bootstrap_offer.spend"] };
  if (!bootstrapOffer.script) throw new Error("DEX bootstrap-offer validator is unavailable.");
  const bootstrapOfferAddress = tools.validatorToAddress("Preprod", bootstrapOffer);
  const factoryState = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["factory_state.factory_state.spend"], [deployment.admin, addressData(tools, bootstrapOfferAddress) as import("@lucid-evolution/lucid").Data]) };
  const amm = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["amm_pool.amm_pool.spend"], [assetData(tools, factoryToken)]) };
  const lp = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["lp_policy.lp_policy.mint"], [assetData(tools, factoryToken), addressData(tools, deployment.ammAddress)]) };
  const poolFactory = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["pool_factory.pool_factory.mint"], [assetData(tools, factoryToken), addressData(tools, deployment.ammAddress), deployment.lpPolicyId]) };
  if (tools.validatorToAddress("Preprod", factoryState) !== deployment.factoryAddress || tools.validatorToAddress("Preprod", amm) !== deployment.ammAddress || tools.mintingPolicyToId(lp) !== deployment.lpPolicyId || tools.mintingPolicyToId(poolFactory) !== deployment.poolPolicyId || deployment.bootstrapOfferAddress !== bootstrapOfferAddress) throw new Error("DEX deployment must be redeployed for the two-party bootstrap validators.");
  return { deployment, scripts: { factoryState, bootstrapOffer, amm, lp, poolFactory } satisfies Scripts };
}

export default function DexWorkbench() {
  const { lucid, address } = useWallet();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [scripts, setScripts] = useState<Scripts | null>(null);
  const [pools, setPools] = useState<Pool[]>([]);
  const [selected, setSelected] = useState("");
  const [action, setAction] = useState<Action>("swap-a");
  const [asset, setAsset] = useState("");
  const [ada, setAda] = useState("10");
  const [amount, setAmount] = useState("1");
  const [fractionAmount, setFractionAmount] = useState("100");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const pool = useMemo(() => pools.find((item) => item.id === selected) ?? pools[0], [pools, selected]);

  const refresh = useCallback(async () => {
    setLoading(true); setMessage(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const loaded = await loadDex(tools); setDeployment(loaded.deployment); setScripts(loaded.scripts);
      if (!lucid) { setPools([]); return; }
      const found: Pool[] = [];
      for (const utxo of await lucid.utxosAt(loaded.deployment.ammAddress)) { try { found.push(decodePool(tools, utxo)); } catch { /* Ignore unrelated outputs. */ } }
      setPools(found); setSelected((current) => found.some((item) => item.id === current) ? current : (found[0]?.id ?? ""));
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to load pools." }); }
    finally { setLoading(false); }
  }, [lucid]);

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);

  async function signSubmit(builder: ReturnType<NonNullable<typeof lucid>["newTx"]>) {
    const completed = await builder.complete();
    return (await completed.sign.withWallet().complete()).submit();
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setMessage(null);
    try {
      if (!lucid || !address) throw new Error("Connect Eternl before submitting a DEX transaction.");
      if (!deployment || !scripts) throw new Error("DEX deployment is not loaded.");
      const tools = await import("@lucid-evolution/lucid");
      const state = await lucid.utxoByUnit(deployment.factoryToken);
      let builder;
      if (action === "create") {
        const fraction = parseUnit(asset); const reserveA = BigInt(ada) * BigInt(1_000_000); const reserveB = BigInt(fractionAmount);
        if (reserveA < BigInt(2_000_000) || reserveB <= BigInt(0)) throw new Error("Initial reserves must include at least 2 ADA and one fraction unit.");
        if (!state.datum) throw new Error("Factory state datum is missing.");
        const before = asConstr(tools.Data.from(state.datum), "factory");
        if (before.fields.length !== 5 || typeof before.fields[3] !== "bigint") throw new Error("Malformed factory datum.");
        const details = tools.getAddressDetails(address);
        if (details.paymentCredential?.type !== "Key" || details.paymentCredential.hash !== deployment.admin) throw new Error("Only the deployed factory admin can create pools.");
        const name = poolName(before.fields[3]); const poolNft = { policyId: deployment.poolPolicyId, assetName: name }; const lpToken = { policyId: deployment.lpPolicyId, assetName: name };
        const liquidity = integerSqrt(reserveA * reserveB);
        const after = new tools.Constr(0, [before.fields[0], before.fields[1], before.fields[2], before.fields[3] + BigInt(1), before.fields[4]]);
        const datum = new tools.Constr(0, [assetData(tools, poolNft), assetData(tools, { policyId: "", assetName: "" }), assetData(tools, fraction), assetData(tools, lpToken), BigInt(997), BigInt(1000), reserveA, reserveB, liquidity, reserveA]);
        builder = lucid.newTx().collectFrom([state], tools.Data.to(new tools.Constr(0, []))).mintAssets({ [assetUnit(poolNft)]: BigInt(1) }, tools.Data.to(new tools.Constr(0, []))).mintAssets({ [assetUnit(lpToken)]: liquidity }, tools.Data.to(new tools.Constr(1, [assetData(tools, poolNft)]))).attach.SpendingValidator(scripts.factoryState).attach.MintingPolicy(scripts.poolFactory).attach.MintingPolicy(scripts.lp).pay.ToContract(deployment.factoryAddress, { kind: "inline", value: tools.Data.to(after) }, { ...state.assets }).pay.ToContract(deployment.ammAddress, { kind: "inline", value: tools.Data.to(datum) }, { lovelace: reserveA, [assetUnit(fraction)]: reserveB, [assetUnit(poolNft)]: BigInt(1) }).pay.ToAddress(address, { [assetUnit(lpToken)]: liquidity }).addSigner(address);
      } else {
        if (!pool) throw new Error("Select an active pool first.");
        let a = pool.reserveA; let b = pool.reserveB; let liquidity = pool.liquidity; let redeemer; let mint = BigInt(0); let lpRedeemer;
        if (action === "swap-a") { const input = BigInt(amount) * (pool.assetA.policyId ? BigInt(1) : BigInt(1_000_000)); const output = input * pool.feeN * b / (a * pool.feeD + input * pool.feeN); if (output <= BigInt(0)) throw new Error("Swap output rounds to zero."); a += input; b -= output; redeemer = new tools.Constr(0, [output]); }
        else if (action === "swap-b") { const input = BigInt(amount); const output = input * pool.feeN * a / (b * pool.feeD + input * pool.feeN); if (output <= BigInt(0)) throw new Error("Swap output rounds to zero."); b += input; a -= output; redeemer = new tools.Constr(0, [output]); }
        else if (action === "add") { const requestedA = BigInt(ada) * (pool.assetA.policyId ? BigInt(1) : BigInt(1_000_000)); const divisor = gcd(a, b); const ratioA = a / divisor; const ratioB = b / divisor; const multiplier = (requestedA + ratioA - BigInt(1)) / ratioA; const addA = ratioA * multiplier; const addB = ratioB * multiplier; mint = addA * liquidity / a; if (mint <= BigInt(0)) throw new Error("Liquidity output rounds to zero."); a += addA; b += addB; liquidity += mint; redeemer = new tools.Constr(1, [mint]); lpRedeemer = new tools.Constr(1, [assetData(tools, pool.poolNft)]); }
        else if (action === "remove") { const burn = BigInt(amount); if (burn <= BigInt(0) || burn >= liquidity) throw new Error("Burn must be positive and smaller than total liquidity; use Destroy pool for the full supply."); const outA = burn * a / liquidity; const outB = burn * b / liquidity; a -= outA; b -= outB; liquidity -= burn; mint = -burn; redeemer = new tools.Constr(2, [outA, outB]); lpRedeemer = new tools.Constr(2, [assetData(tools, pool.poolNft)]); }
        else {
          const details = tools.getAddressDetails(address);
          if (details.paymentCredential?.type !== "Key" || details.paymentCredential.hash !== deployment.admin) throw new Error("Only the factory admin can destroy a pool.");
          builder = lucid.newTx().collectFrom([pool.utxo], tools.Data.to(new tools.Constr(3, [addressData(tools, address)]))).readFrom([state]).mintAssets({ [assetUnit(pool.poolNft)]: -BigInt(1) }, tools.Data.to(new tools.Constr(1, []))).mintAssets({ [assetUnit(pool.lpToken)]: -pool.liquidity }, tools.Data.to(new tools.Constr(3, [assetData(tools, pool.poolNft)]))).attach.SpendingValidator(scripts.amm).attach.MintingPolicy(scripts.poolFactory).attach.MintingPolicy(scripts.lp).pay.ToAddress(address, reservePayout(pool)).addSigner(address);
          const hash = await signSubmit(builder); const confirmed = await lucid.awaitTx(hash); if (!confirmed) throw new Error(`Pool destruction was submitted but not confirmed: ${hash}`); await refresh(); setMessage({ kind: "success", text: `Pool destroyed. Transaction ${hash}` }); return;
        }
        const datum = nextDatum(tools, pool, a, b, liquidity);
        builder = lucid.newTx().collectFrom([pool.utxo], tools.Data.to(redeemer!)).readFrom([state]).attach.SpendingValidator(scripts.amm).pay.ToContract(deployment.ammAddress, { kind: "inline", value: tools.Data.to(datum) }, poolValue(pool, a, b));
        if (mint !== BigInt(0)) builder = builder.mintAssets({ [assetUnit(pool.lpToken)]: mint }, tools.Data.to(lpRedeemer!)).attach.MintingPolicy(scripts.lp);
      }
      const hash = await signSubmit(builder); const confirmed = await lucid.awaitTx(hash); if (!confirmed) throw new Error(`Transaction was submitted but not confirmed: ${hash}`); await refresh(); setMessage({ kind: "success", text: `Transaction confirmed: ${hash}` });
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "DEX transaction failed." }); }
    finally { setLoading(false); }
  }

  const estimate = pool && (action === "swap-a" || action === "swap-b") ? (() => { try { const input = BigInt(amount || "0") * (action === "swap-a" ? (pool.assetA.policyId ? BigInt(1) : BigInt(1_000_000)) : BigInt(1)); return action === "swap-a" ? input * pool.feeN * pool.reserveB / (pool.reserveA * pool.feeD + input * pool.feeN) : input * pool.feeN * pool.reserveA / (pool.reserveB * pool.feeD + input * pool.feeN); } catch { return BigInt(0); } })() : null;

  return <section className="dex-workbench"><div className="dex-card"><div className="section-heading"><div><span className="section-kicker">Constant-product exchange</span><h2>Fraction liquidity pools</h2></div><span className="network-badge"><i /> Preprod</span></div><p className="dex-intro">Trade fractionalized RWA tokens against tADA or a supported native quote asset, provide liquidity, or administer pool lifecycle operations. Every operation is signed by the connected wallet.</p><div className="dex-tabs">{actions.map((item) => <button key={item.id} type="button" className={action === item.id ? "selected" : ""} onClick={() => setAction(item.id)}>{item.label}</button>)}</div><form onSubmit={submit}>
    {action !== "create" && <label className="field dex-field"><span className="field-label">Pool</span><select value={pool?.id ?? ""} onChange={(event) => setSelected(event.target.value)} disabled={!pools.length}>{pools.length ? pools.map((item) => <option key={item.id} value={item.id}>{displayName(item.assetB)} · {item.assetB.policyId.slice(0, 8)}…</option>) : <option>No active pools</option>}</select></label>}
    {action === "create" && <div className="dex-form-grid"><label className="field field-wide"><span className="field-label">Fraction asset unit</span><input value={asset} onChange={(event) => setAsset(event.target.value)} placeholder="policy ID + asset name hex" required /></label><label className="field"><span className="field-label">Initial tADA</span><input type="number" min="2" step="1" value={ada} onChange={(event) => setAda(event.target.value)} required /></label><label className="field"><span className="field-label">Initial fraction units</span><input type="number" min="1" step="1" value={fractionAmount} onChange={(event) => setFractionAmount(event.target.value)} required /></label></div>}
    {action === "add" && <label className="field dex-field"><span className="field-label">{pool ? displayName(pool.assetA) + " to add" : "Quote asset to add"}</span><input type="number" min="1" step="1" value={ada} onChange={(event) => setAda(event.target.value)} required /><span className="field-hint">The matching fraction amount is calculated from the current reserve ratio.</span></label>}
    {(action === "swap-a" || action === "swap-b" || action === "remove") && <label className="field dex-field"><span className="field-label">{action === "swap-a" ? (pool ? displayName(pool.assetA) + " to spend" : "Quote asset to spend") : action === "swap-b" ? "Fraction units to sell" : "LP units to burn"}</span><input type="number" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} required />{estimate !== null && <span className="field-hint">Estimated output: {format(action === "swap-b" && !pool?.assetA.policyId ? estimate / BigInt(1_000_000) : estimate)} {action === "swap-b" ? (pool ? displayName(pool.assetA) : "quote units") : "fraction units"} before transaction fees.</span>}</label>}
    {action === "destroy" && <div className="dex-warning">Destroying requires the admin wallet to hold and burn the pool&apos;s entire LP supply. All reserves return to that wallet.</div>}
    <div className="form-footer"><p><span className="status-dot" /> {pools.length} active pool{pools.length === 1 ? "" : "s"}</p><button className="primary-button" type="submit" disabled={loading || (!pool && action !== "create")}>{loading ? "Working…" : actions.find((item) => item.id === action)?.label} <span className="button-arrow">↗</span></button></div>
  </form>{message && <p className={`form-message ${message.kind === "error" ? "error-message" : "success-message"}`}>{message.text}</p>}</div>
  <DexBootstrapWorkbench />
  <div className="dex-pools"><div className="dex-pools-head"><div><span className="section-kicker">On-chain state</span><h3>Active pools</h3></div><button type="button" className="refresh-button" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>{!lucid ? <p className="dex-empty">Connect Eternl to read and operate the deployed pools.</p> : pools.length === 0 ? <p className="dex-empty">No active pool is currently indexed.</p> : pools.map((item) => <article className="dex-pool" key={item.id}><div><strong>{displayName(item.assetB)} / {displayName(item.assetA)}</strong><code>{assetUnit(item.assetB)}</code></div><dl><div><dt>{displayName(item.assetA)} reserve</dt><dd>{format(item.assetA.policyId ? item.reserveA : item.reserveA / BigInt(1_000_000))}</dd></div><div><dt>Fraction reserve</dt><dd>{format(item.reserveB)}</dd></div><div><dt>LP supply</dt><dd>{format(item.liquidity)}</dd></div><div><dt>Fee</dt><dd>{Number(item.feeD - item.feeN) / Number(item.feeD) * 100}%</dd></div></dl></article>)}{deployment && <a className="explorer-link" href={`https://preprod.cardanoscan.io/address/${deployment.ammAddress}`} target="_blank" rel="noreferrer">Inspect DEX on Cardanoscan <span className="button-arrow">↗</span></a>}</div></section>;
}
