"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "./wallet-context";

type AssetClass = { policyId: string; assetName: string };
type DataConstr = { index: number; fields: unknown[] };
type PoolState = {
  utxo: import("@lucid-evolution/lucid").UTxO;
  datum: DataConstr;
  poolToken: AssetClass;
  lpToken: AssetClass;
  quoteAsset: AssetClass;
  totalLpSupply: bigint;
  minCashReserve: bigint;
  paused: boolean;
};

function asConstr(value: unknown, label: string): DataConstr {
  if (typeof value !== "object" || value === null || !("index" in value) || !("fields" in value)) throw new Error("Malformed " + label + " datum.");
  const candidate = value as { index: unknown; fields: unknown };
  if (typeof candidate.index !== "number" || !Array.isArray(candidate.fields)) throw new Error("Malformed " + label + " datum.");
  return { index: candidate.index, fields: candidate.fields };
}

function asAsset(value: unknown, label: string): AssetClass {
  const asset = asConstr(value, label);
  if (asset.index !== 0 || asset.fields.length !== 2 || typeof asset.fields[0] !== "string" || typeof asset.fields[1] !== "string") throw new Error("Malformed " + label + " asset.");
  return { policyId: asset.fields[0], assetName: asset.fields[1] };
}

function decodePoolDatum(value: unknown): Omit<PoolState, "utxo"> {
  const datum = asConstr(value, "quote pool");
  if (datum.index !== 0 || datum.fields.length !== 8 || typeof datum.fields[5] !== "bigint" || typeof datum.fields[6] !== "bigint" || typeof datum.fields[7] !== "boolean") throw new Error("Malformed quote pool datum.");
  return {
    datum,
    poolToken: asAsset(datum.fields[2], "pool token"),
    lpToken: asAsset(datum.fields[3], "LP token"),
    quoteAsset: asAsset(datum.fields[4], "quote asset"),
    totalLpSupply: datum.fields[5],
    minCashReserve: datum.fields[6],
    paused: datum.fields[7],
  };
}

function unit(asset: AssetClass): string {
  return asset.policyId ? asset.policyId + asset.assetName : "lovelace";
}

function assetLabel(asset: AssetClass): string {
  return asset.policyId ? asset.policyId.slice(0, 12) + "…" + asset.assetName : "ADA";
}

function addAsset(assets: import("@lucid-evolution/lucid").Assets, asset: AssetClass, amount: bigint): import("@lucid-evolution/lucid").Assets {
  const key = unit(asset);
  return { ...assets, [key]: (assets[key] || BigInt(0)) + amount };
}

function assetData(ConstrClass: typeof import("@lucid-evolution/lucid").Constr, asset: AssetClass): DataConstr {
  return new ConstrClass(0, [asset.policyId, asset.assetName]) as DataConstr;
}

function addressData(
  Data: typeof import("@lucid-evolution/lucid").Data,
  AddressSchema: typeof import("@lucid-evolution/lucid").AddressSchema,
  getAddressDetails: typeof import("@lucid-evolution/lucid").getAddressDetails,
  address: string,
): unknown {
  const details = getAddressDetails(address);
  if (!details?.paymentCredential) throw new Error("The connected wallet has no supported payment credential.");
  const payment = details.paymentCredential.type === "Key" ? { PubKeyCredential: [details.paymentCredential.hash] } : { ScriptCredential: [details.paymentCredential.hash] };
  const staking = details.stakeCredential ? { StakingHash: [details.stakeCredential.type === "Key" ? { PubKeyCredential: [details.stakeCredential.hash] } : { ScriptCredential: [details.stakeCredential.hash] }] } : null;
  return Data.from(Data.to({ addressCredential: payment, addressStakingCredential: staking } as never, AddressSchema as never));
}

async function loadCode(title: string): Promise<string> {
  const response = await fetch("/api/marketplace-blueprint?validator=" + encodeURIComponent(title), { cache: "no-store" });
  const body = await response.json() as { compiledCode?: string; error?: string };
  if (!response.ok || !body.compiledCode) throw new Error(body.error || "Marketplace validator unavailable.");
  return body.compiledCode;
}

export default function ReservesWorkbench() {
  const { address, lucid } = useWallet();
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [lpAmount, setLpAmount] = useState("");
  const [pool, setPool] = useState<PoolState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const quotePoolAddress = process.env.NEXT_PUBLIC_QUOTE_POOL_ADDRESS ?? "";
  const orderbookAddress = process.env.NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS ?? "";

  const refresh = useCallback(async () => {
    setMessage(null);
    if (!lucid || !quotePoolAddress) {
      setPool(null);
      setLoaded(true);
      return;
    }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const candidates = await lucid.utxosAt(quotePoolAddress);
      let found: PoolState | null = null;
      for (const utxo of candidates) {
        if (!utxo.datum) continue;
        try {
          const decoded = decodePoolDatum(tools.Data.from(utxo.datum));
          found = { utxo, ...decoded };
          break;
        } catch {
          // Ignore unrelated outputs at the configured pool address.
        }
      }
      setPool(found);
      setLoaded(true);
      if (!found) setMessage({ kind: "error", text: "No quote-pool UTxO with a valid inline datum was found at the configured address." });
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to read the quote-pool reserves." });
    } finally {
      setLoading(false);
    }
  }, [lucid, quotePoolAddress]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const quoteUnit = useMemo(() => pool ? unit(pool.quoteAsset) : "", [pool]);
  const cash = pool ? pool.utxo.assets[quoteUnit] || BigInt(0) : BigInt(0);
  const withdrawable = pool ? cash - pool.minCashReserve : BigInt(0);

  function selectMode(nextMode: "add" | "remove") {
    setMode(nextMode);
    setAmount("");
    setLpAmount("");
    setMessage(null);
  }

  async function submitLiquidity() {
    setMessage(null);
    if (!lucid || !address) { setMessage({ kind: "error", text: "Connect Eternl before managing reserves." }); return; }
    if (!pool) { setMessage({ kind: "error", text: "No active quote pool is available." }); return; }
    if (!quotePoolAddress || !orderbookAddress) { setMessage({ kind: "error", text: "Configure both quote-pool and orderbook addresses first." }); return; }
    if (pool.paused) { setMessage({ kind: "error", text: "This quote pool is paused." }); return; }
    const input = mode === "add" ? amount : lpAmount;
    if (!/^[1-9]\d*$/.test(input)) { setMessage({ kind: "error", text: mode === "add" ? "Enter a positive reserve amount." : "Enter a positive LP token amount." }); return; }

    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const details = tools.getAddressDetails(address);
      if (!details?.paymentCredential || details.paymentCredential.type !== "Key") throw new Error("The connected wallet needs a payment-key address.");
      const provider = addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, address);
      const providerKey = details.paymentCredential.hash;
      const poolCode = await loadCode("quote_pool.quote_pool.spend");
      const poolScript = {
        type: "PlutusV3" as const,
        script: tools.applyParamsToScript(poolCode, [addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, orderbookAddress) as import("@lucid-evolution/lucid").Data]),
      };
      const lpCode = await loadCode("lp_policy.lp_policy.mint");
      const lpPolicy = {
        type: "PlutusV3" as const,
        script: tools.applyParamsToScript(lpCode, [assetData(tools.Constr, pool.poolToken) as import("@lucid-evolution/lucid").Data, pool.lpToken.assetName as import("@lucid-evolution/lucid").Data]),
      };
      if (tools.mintingPolicyToId(lpPolicy) !== pool.lpToken.policyId) throw new Error("The pool LP token does not match the configured LP policy.");
      const lpUnit = unit(pool.lpToken);
      const quoteAmount = mode === "add" ? BigInt(amount) : BigInt(0);
      let lpChange: bigint;
      let reserveAmount: bigint;
      if (mode === "add") {
        if (pool.totalLpSupply > BigInt(0) && cash <= BigInt(0)) throw new Error("The pool has LP supply but no quote-asset reserve.");
        lpChange = pool.totalLpSupply === BigInt(0) ? quoteAmount : quoteAmount * pool.totalLpSupply / cash;
        reserveAmount = quoteAmount;
        if (lpChange <= BigInt(0)) throw new Error("This reserve amount is too small to mint an LP share.");
      } else {
        const burned = BigInt(lpAmount);
        if (pool.totalLpSupply <= BigInt(0) || withdrawable <= BigInt(0)) throw new Error("No withdrawable reserve is currently available.");
        if (burned > pool.totalLpSupply) throw new Error("You cannot withdraw more LP tokens than the pool supply.");
        reserveAmount = burned * withdrawable / pool.totalLpSupply;
        lpChange = burned;
        if (reserveAmount <= BigInt(0)) throw new Error("This LP amount is too small to withdraw any reserve.");
      }
      const nextSupply = mode === "add" ? pool.totalLpSupply + lpChange : pool.totalLpSupply - lpChange;
      const nextDatum = new tools.Constr(0, [pool.datum.fields[0], pool.datum.fields[1], pool.datum.fields[2], pool.datum.fields[3], pool.datum.fields[4], nextSupply, pool.datum.fields[6], pool.datum.fields[7]]);
      const nextAssets = addAsset(pool.utxo.assets, pool.quoteAsset, mode === "add" ? reserveAmount : -reserveAmount);
      const redeemer = mode === "add"
        ? new tools.Constr(0, [reserveAmount, lpChange, provider, providerKey, nextDatum])
        : new tools.Constr(1, [reserveAmount, lpChange, provider, providerKey, nextDatum]);
      const tx = lucid.newTx()
        .collectFrom([pool.utxo], tools.Data.to(redeemer as import("@lucid-evolution/lucid").Data))
        .mintAssets({ [lpUnit]: mode === "add" ? lpChange : -lpChange }, tools.Data.to(new tools.Constr(mode === "add" ? 0 : 1, []) as import("@lucid-evolution/lucid").Data))
        .attach.SpendingValidator(poolScript)
        .attach.MintingPolicy(lpPolicy)
        .pay.ToContract(quotePoolAddress, { kind: "inline", value: tools.Data.to(nextDatum as import("@lucid-evolution/lucid").Data) }, nextAssets)
        .addSigner(address);
      const balanced = mode === "add"
        ? tx.pay.ToAddress(address, { [lpUnit]: lpChange })
        : tx.pay.ToAddress(address, pool.quoteAsset.policyId ? { [quoteUnit]: reserveAmount } : { lovelace: reserveAmount });
      const hash = await (await (await balanced.complete()).sign.withWallet().complete()).submit();
      setMessage({ kind: "success", text: (mode === "add" ? "Reserve added: " : "Reserve withdrawn: ") + hash });
      setAmount("");
      setLpAmount("");
      await refresh();
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The reserve transaction failed or was cancelled." });
    } finally {
      setLoading(false);
    }
  }

  const configured = Boolean(quotePoolAddress && orderbookAddress);
  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">Liquidity / instant sell reserves</span><h2>Manage shared settlement reserves</h2></div><span className="step-badge">{configured ? pool ? "Pool ready" : loaded ? "Pool unavailable" : "Loading" : "Addresses needed"}</span></div><p className="mint-intro">Add or withdraw the quote asset used to settle Instant Sell orders. LP shares track each provider’s claim on the withdrawable reserve.</p><div className="segmented-control"><button type="button" className={mode === "add" ? "selected" : ""} onClick={() => selectMode("add")}>Add reserves</button><button type="button" className={mode === "remove" ? "selected" : ""} onClick={() => selectMode("remove")}>Remove reserves</button></div><div className="calculation-card"><span>Active quote pool</span><strong>{pool ? assetLabel(pool.quoteAsset) + " reserve · " + cash.toString() : configured ? "Connect Eternl to load the pool" : "Configure the pool and orderbook addresses"}</strong><p>{pool ? "LP supply: " + pool.totalLpSupply.toString() + " · Minimum reserve: " + pool.minCashReserve.toString() + " · Pool token: " + assetLabel(pool.poolToken) : "The pool must contain an inline QuotePoolDatum."}</p></div><div className="field-grid">{mode === "add" ? <Field label={pool ? "Reserve amount (" + assetLabel(pool.quoteAsset) + ")" : "Reserve amount"} value={amount} onChange={setAmount} placeholder="Smallest quote-asset units" hint="The quote asset is added to the shared pool." /> : <Field label="LP tokens to burn" value={lpAmount} onChange={setLpAmount} placeholder="LP token quantity" hint={pool ? "Withdrawable reserve: " + withdrawable.toString() + " " + assetLabel(pool.quoteAsset) : "Load the pool first."} />}</div>{message && <p className={message.kind === "error" ? "form-message error-message" : "form-message success-message"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}<div className="form-footer"><p><span className="status-dot" />{lucid ? " Eternl connected - ready to sign." : " Connect Eternl to manage reserves."}</p><button type="button" className="primary-button" onClick={() => void submitLiquidity()} disabled={loading || !pool}>{loading ? "Awaiting wallet…" : mode === "add" ? "Add reserves" : "Remove reserves"} <span className="button-arrow">Go</span></button></div></section>;
}

function Field({ label, placeholder, hint, value, onChange }: { label: string; placeholder: string; hint?: string; value: string; onChange: (value: string) => void }) {
  return <label className="field"><span className="field-label">{label}</span><input inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />{hint && <span className="field-hint">{hint}</span>}</label>;
}
