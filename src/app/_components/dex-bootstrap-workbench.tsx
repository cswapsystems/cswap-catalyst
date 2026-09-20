"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "./wallet-context";

type Tools = typeof import("@lucid-evolution/lucid");
type AssetClass = { policyId: string; assetName: string };
type Constr = { index: number; fields: unknown[] };
type Deployment = {
  network: "preprod";
  admin: string;
  factoryToken: string;
  factoryAddress: string;
  ammAddress: string;
  lpPolicyId: string;
  poolPolicyId: string;
  bootstrapOfferAddress?: string;
};
type Context = {
  deployment: Deployment;
  bootstrapAddress: string;
  scripts: {
    offer: import("@lucid-evolution/lucid").Script;
    factory: import("@lucid-evolution/lucid").Script;
    amm: import("@lucid-evolution/lucid").Script;
    lp: import("@lucid-evolution/lucid").Script;
    poolFactory: import("@lucid-evolution/lucid").Script;
  };
};
type Offer = {
  id: string;
  utxo: import("@lucid-evolution/lucid").UTxO;
  owner: string;
  ownerKey: string;
  factoryToken: AssetClass;
  fraction: AssetClass;
  fractionAmount: bigint;
  quote: AssetClass;
  quoteAmount: bigint;
  poolLovelace: bigint;
  ownerShareBps: bigint;
  managed: boolean;
};
type Form = {
  fractionUnit: string;
  fractionAmount: string;
  quoteKind: "ada" | "usdcx";
  usdcxUnit: string;
  quoteAmount: string;
  poolAda: string;
  ownerShare: string;
};

const initialForm: Form = {
  fractionUnit: "",
  fractionAmount: "100",
  quoteKind: "ada",
  usdcxUnit: process.env.NEXT_PUBLIC_USDCX_UNIT ?? "",
  quoteAmount: "10",
  poolAda: "2",
  ownerShare: "50",
};

function asConstr(value: unknown, label: string): Constr {
  if (!value || typeof value !== "object" || !("index" in value) || !("fields" in value)) throw new Error("Malformed " + label + ".");
  const candidate = value as { index: unknown; fields: unknown };
  if (typeof candidate.index !== "number" || !Array.isArray(candidate.fields)) throw new Error("Malformed " + label + ".");
  return { index: candidate.index, fields: candidate.fields };
}

function assetData(tools: Tools, asset: AssetClass) {
  return new tools.Constr(0, [asset.policyId, asset.assetName]);
}

function assetFrom(value: unknown, label: string): AssetClass {
  const asset = asConstr(value, label);
  if (asset.index !== 0 || asset.fields.length !== 2 || typeof asset.fields[0] !== "string" || typeof asset.fields[1] !== "string") throw new Error("Malformed " + label + " asset.");
  return { policyId: asset.fields[0], assetName: asset.fields[1] };
}

function assetUnit(asset: AssetClass) {
  return asset.policyId ? asset.policyId + asset.assetName : "lovelace";
}

function parseUnit(value: string, label: string): AssetClass {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length < 56 || normalized.length % 2 !== 0) throw new Error(label + " must be a policy ID plus asset name in hexadecimal.");
  return { policyId: normalized.slice(0, 56), assetName: normalized.slice(56) };
}

function addressData(tools: Tools, address: string) {
  const details = tools.getAddressDetails(address);
  if (!details?.paymentCredential) throw new Error("Address has no supported payment credential.");
  const credential = (item: { type: "Key" | "Script"; hash: string }) => item.type === "Key" ? { PubKeyCredential: [item.hash] } : { ScriptCredential: [item.hash] };
  return tools.Data.from(tools.Data.to({
    addressCredential: credential(details.paymentCredential),
    addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null,
  } as never, tools.AddressSchema as never));
}

function addressFrom(tools: Tools, value: unknown): string {
  const root = asConstr(value, "offer owner");
  if (root.index !== 0 || root.fields.length !== 2) throw new Error("Malformed offer owner.");
  const credential = (raw: unknown) => {
    const item = asConstr(raw, "credential");
    if (item.fields.length !== 1 || typeof item.fields[0] !== "string") throw new Error("Malformed offer credential.");
    return { type: item.index === 0 ? "Key" as const : "Script" as const, hash: item.fields[0] };
  };
  const payment = credential(root.fields[0]);
  if (root.fields[1] === null) return tools.credentialToAddress("Preprod", payment);
  const stake = asConstr(root.fields[1], "staking credential");
  if (stake.index !== 0 || stake.fields.length !== 1) throw new Error("Malformed offer staking credential.");
  return tools.credentialToAddress("Preprod", payment, credential(asConstr(stake.fields[0], "staking hash").fields[0]));
}

function poolName(id: bigint) {
  return id.toString(16).padStart(16, "0");
}

function integerSqrt(value: bigint) {
  if (value < BigInt(0)) throw new Error("Negative liquidity is invalid.");
  if (value < BigInt(2)) return value;
  let estimate = value;
  let next = (estimate + BigInt(1)) / BigInt(2);
  while (next < estimate) {
    estimate = next;
    next = (estimate + value / estimate) / BigInt(2);
  }
  return estimate;
}

function format(value: bigint) {
  return new Intl.NumberFormat("en-US").format(value);
}

function displayAsset(asset: AssetClass) {
  if (!asset.policyId) return "tADA";
  try {
    const bytes = Uint8Array.from(asset.assetName.match(/.{2}/g) ?? [], (item) => Number.parseInt(item, 16));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes) || "Token";
  } catch {
    return "Token";
  }
}

function parseShareBps(value: string) {
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(value)) throw new Error("Owner LP share must be between 0.01% and 99.99%.");
  const [whole, decimal = ""] = value.split(".");
  const bps = BigInt(whole) * BigInt(100) + BigInt((decimal + "00").slice(0, 2));
  if (bps <= BigInt(0) || bps >= BigInt(10_000)) throw new Error("Owner LP share must leave a positive share for both participants.");
  return bps;
}

function decodeOffer(tools: Tools, utxo: import("@lucid-evolution/lucid").UTxO, managedKey?: string): Offer {
  if (!utxo.datum) throw new Error("Bootstrap offer has no inline datum.");
  const datum = asConstr(tools.Data.from(utxo.datum), "bootstrap offer");
  if (datum.index !== 0 || datum.fields.length !== 9 || typeof datum.fields[1] !== "string" || typeof datum.fields[4] !== "bigint" || typeof datum.fields[6] !== "bigint" || typeof datum.fields[7] !== "bigint" || typeof datum.fields[8] !== "bigint") throw new Error("Malformed bootstrap offer datum.");
  const ownerKey = datum.fields[1];
  return {
    id: utxo.txHash + "#" + utxo.outputIndex,
    utxo,
    owner: addressFrom(tools, datum.fields[0]),
    ownerKey,
    factoryToken: assetFrom(datum.fields[2], "factory token"),
    fraction: assetFrom(datum.fields[3], "fraction"),
    fractionAmount: datum.fields[4],
    quote: assetFrom(datum.fields[5], "quote"),
    quoteAmount: datum.fields[6],
    poolLovelace: datum.fields[7],
    ownerShareBps: datum.fields[8],
    managed: ownerKey === managedKey,
  };
}

async function loadContext(tools: Tools): Promise<Context> {
  const response = await fetch("/api/dex-blueprint", { cache: "no-store" });
  const body = await response.json() as { validators?: Record<string, string>; deployment?: Deployment; error?: string };
  if (!response.ok || !body.validators || !body.deployment) throw new Error(body.error ?? "DEX deployment is unavailable.");
  const deployment = body.deployment;
  const factoryToken = parseUnit(deployment.factoryToken, "Factory token");
  const offer = { type: "PlutusV3" as const, script: body.validators["bootstrap_offer.bootstrap_offer.spend"] };
  if (!offer.script) throw new Error("DEX bootstrap-offer validator is unavailable.");
  const bootstrapAddress = tools.validatorToAddress("Preprod", offer);
  const factory = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["factory_state.factory_state.spend"], [deployment.admin, addressData(tools, bootstrapAddress) as import("@lucid-evolution/lucid").Data]) };
  const amm = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["amm_pool.amm_pool.spend"], [assetData(tools, factoryToken)]) };
  const lp = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["lp_policy.lp_policy.mint"], [assetData(tools, factoryToken), addressData(tools, deployment.ammAddress) as import("@lucid-evolution/lucid").Data]) };
  const poolFactory = { type: "PlutusV3" as const, script: tools.applyParamsToScript(body.validators["pool_factory.pool_factory.mint"], [assetData(tools, factoryToken), addressData(tools, deployment.ammAddress) as import("@lucid-evolution/lucid").Data, deployment.lpPolicyId]) };
  if (deployment.bootstrapOfferAddress !== bootstrapAddress || tools.validatorToAddress("Preprod", factory) !== deployment.factoryAddress || tools.validatorToAddress("Preprod", amm) !== deployment.ammAddress || tools.mintingPolicyToId(lp) !== deployment.lpPolicyId || tools.mintingPolicyToId(poolFactory) !== deployment.poolPolicyId) throw new Error("DEX deployment must be redeployed for the two-party bootstrap validators.");
  return { deployment, bootstrapAddress, scripts: { offer, factory, amm, lp, poolFactory } };
}

export default function DexBootstrapWorkbench() {
  const { address, lucid, connect } = useWallet();
  const [context, setContext] = useState<Context | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [form, setForm] = useState<Form>(initialForm);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setMessage(null);
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const next = await loadContext(tools);
      setContext(next);
      if (!lucid) {
        setOffers([]);
        return;
      }
      const ownerKey = address && tools.getAddressDetails(address).paymentCredential?.type === "Key" ? tools.getAddressDetails(address).paymentCredential?.hash : undefined;
      const found: Offer[] = [];
      for (const utxo of await lucid.utxosAt(next.bootstrapAddress)) {
        try {
          found.push(decodeOffer(tools, utxo, ownerKey));
        } catch {
          // Ignore any unrelated UTxO sent to the offer script.
        }
      }
      setOffers(found);
    } catch (cause) {
      setContext(null);
      setOffers([]);
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to load bootstrap offers." });
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [address, lucid]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const update = <Key extends keyof Form>(key: Key, value: Form[Key]) => setForm((current) => ({ ...current, [key]: value }));

  async function submitOffer(event: FormEvent) {
    event.preventDefault();
    if (!lucid || !address || !context) {
      setMessage({ kind: "error", text: "Connect Eternl and load the redeployed DEX before creating an offer." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const details = tools.getAddressDetails(address);
      if (details.paymentCredential?.type !== "Key") throw new Error("The FT-owner wallet needs a payment-key address.");
      const fraction = parseUnit(form.fractionUnit, "FT asset unit");
      const quote = form.quoteKind === "ada" ? { policyId: "", assetName: "" } : parseUnit(form.usdcxUnit, "USDCx asset unit");
      const fractionAmount = BigInt(form.fractionAmount);
      const quoteAmount = BigInt(form.quoteAmount) * (quote.policyId ? BigInt(1) : BigInt(1_000_000));
      const poolLovelace = BigInt(form.poolAda) * BigInt(1_000_000);
      const ownerShareBps = parseShareBps(form.ownerShare);
      if (fractionAmount <= BigInt(0) || quoteAmount <= BigInt(0) || poolLovelace < BigInt(2_000_000)) throw new Error("Use a positive FT amount, positive quote reserve, and an ADA buffer of at least 2.");
      if (!quote.policyId && poolLovelace > quoteAmount) throw new Error("The ADA reserve must be at least as large as the locked ADA buffer.");
      const datum = new tools.Constr(0, [
        addressData(tools, address),
        details.paymentCredential.hash,
        assetData(tools, parseUnit(context.deployment.factoryToken, "Factory token")),
        assetData(tools, fraction),
        fractionAmount,
        assetData(tools, quote),
        quoteAmount,
        poolLovelace,
        ownerShareBps,
      ]);
      const tx = lucid.newTx()
        .pay.ToContract(context.bootstrapAddress, { kind: "inline", value: tools.Data.to(datum as import("@lucid-evolution/lucid").Data) }, { lovelace: poolLovelace, [assetUnit(fraction)]: fractionAmount })
        .addSigner(address);
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
      setMessage({ kind: "success", text: "Bootstrap offer submitted: " + hash });
      setForm(initialForm);
      await refresh();
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The bootstrap offer could not be submitted." });
    } finally {
      setLoading(false);
    }
  }

  async function accept(offer: Offer) {
    if (!lucid || !address || !context) {
      setMessage({ kind: "error", text: "Connect the liquidity-provider wallet before accepting an offer." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      if (offer.managed) throw new Error("A different wallet must provide the quote side.");
      const factoryState = await lucid.utxoByUnit(context.deployment.factoryToken);
      if (!factoryState.datum) throw new Error("Factory state datum is missing.");
      const before = asConstr(tools.Data.from(factoryState.datum), "factory state");
      if (before.index !== 0 || before.fields.length !== 5 || typeof before.fields[3] !== "bigint") throw new Error("Malformed factory state datum.");
      const factoryToken = parseUnit(context.deployment.factoryToken, "Factory token");
      if (assetUnit(assetFrom(before.fields[0], "factory token")) !== assetUnit(factoryToken)) throw new Error("Factory state token mismatch.");
      const name = poolName(before.fields[3]);
      const poolNft = { policyId: context.deployment.poolPolicyId, assetName: name };
      const lpToken = { policyId: context.deployment.lpPolicyId, assetName: name };
      const liquidity = integerSqrt(offer.quoteAmount * offer.fractionAmount);
      const ownerLp = liquidity * offer.ownerShareBps / BigInt(10_000);
      const providerLp = liquidity - ownerLp;
      if (liquidity <= BigInt(1) || ownerLp <= BigInt(0) || providerLp <= BigInt(0)) throw new Error("The proposed reserves are too small to split initial LP shares.");
      const poolLovelace = offer.quote.policyId ? offer.poolLovelace : offer.quoteAmount;
      const after = new tools.Constr(0, [before.fields[0], before.fields[1], before.fields[2], before.fields[3] + BigInt(1), before.fields[4]]);
      const pool = new tools.Constr(0, [assetData(tools, poolNft), assetData(tools, offer.quote), assetData(tools, offer.fraction), assetData(tools, lpToken), BigInt(997), BigInt(1000), offer.quoteAmount, offer.fractionAmount, liquidity, poolLovelace]);
      const offerRedeemer = new tools.Constr(0, [addressData(tools, address)]);
      const tx = lucid.newTx()
        .collectFrom([offer.utxo], tools.Data.to(offerRedeemer as import("@lucid-evolution/lucid").Data))
        .collectFrom([factoryState], tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data))
        .mintAssets({ [assetUnit(poolNft)]: BigInt(1) }, tools.Data.to(new tools.Constr(0, []) as import("@lucid-evolution/lucid").Data))
        .mintAssets({ [assetUnit(lpToken)]: liquidity }, tools.Data.to(new tools.Constr(0, [assetData(tools, poolNft)]) as import("@lucid-evolution/lucid").Data))
        .attach.SpendingValidator(context.scripts.offer)
        .attach.SpendingValidator(context.scripts.factory)
        .attach.MintingPolicy(context.scripts.poolFactory)
        .attach.MintingPolicy(context.scripts.lp)
        .pay.ToContract(context.deployment.factoryAddress, { kind: "inline", value: tools.Data.to(after as import("@lucid-evolution/lucid").Data) }, { ...factoryState.assets })
        .pay.ToContract(context.deployment.ammAddress, { kind: "inline", value: tools.Data.to(pool as import("@lucid-evolution/lucid").Data) }, offer.quote.policyId ? { lovelace: poolLovelace, [assetUnit(offer.quote)]: offer.quoteAmount, [assetUnit(offer.fraction)]: offer.fractionAmount, [assetUnit(poolNft)]: BigInt(1) } : { lovelace: offer.quoteAmount, [assetUnit(offer.fraction)]: offer.fractionAmount, [assetUnit(poolNft)]: BigInt(1) })
        .pay.ToAddress(offer.owner, { [assetUnit(lpToken)]: ownerLp })
        .pay.ToAddress(address, { [assetUnit(lpToken)]: providerLp })
        .addSigner(address);
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
      setMessage({ kind: "success", text: "Pool bootstrap submitted: " + hash });
      await refresh();
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The offer could not be accepted." });
    } finally {
      setLoading(false);
    }
  }

  async function cancel(offer: Offer) {
    if (!lucid || !address || !context || !offer.managed) {
      setMessage({ kind: "error", text: "Connect the FT-owner wallet to cancel this offer." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const tx = lucid.newTx()
        .collectFrom([offer.utxo], tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data))
        .attach.SpendingValidator(context.scripts.offer)
        .pay.ToAddress(offer.owner, { ...offer.utxo.assets })
        .addSigner(address);
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
      setMessage({ kind: "success", text: "Bootstrap offer cancelled: " + hash });
      await refresh();
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The offer could not be cancelled." });
    } finally {
      setLoading(false);
    }
  }

  const offerSummary = useMemo(() => offers.map((offer) => {
    const liquidity = integerSqrt(offer.quoteAmount * offer.fractionAmount);
    return { offer, liquidity, ownerLp: liquidity * offer.ownerShareBps / BigInt(10_000) };
  }), [offers]);

  return <section className="dex-bootstrap">
    <div className="dex-bootstrap-head">
      <div><span className="section-kicker">Two-party liquidity launch</span><h2>Pair an FT owner with a liquidity provider</h2></div>
      <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh offers"}</button>
    </div>
    <p className="dex-intro">The FT owner locks tokens and the pool terms on-chain. A second wallet supplies the quoted tADA or USDCx reserve, which atomically creates the pool and splits all initial LP tokens between both participants.</p>
    <ol className="dex-bootstrap-steps"><li><span>01</span><div><strong>FT owner creates an offer</strong><p>Token quantity, quote reserve, ADA buffer and LP split are fixed in the datum.</p></div></li><li><span>02</span><div><strong>LP funds the quote side</strong><p>The provider reviews the fixed terms and signs once with the required tADA or USDCx.</p></div></li><li><span>03</span><div><strong>Pool and LP shares settle together</strong><p>The pool NFT, AMM UTxO and both LP allocations are validated in the same transaction.</p></div></li></ol>
    <form className="dex-bootstrap-form" onSubmit={submitOffer}>
      <div className="section-heading"><div><span className="section-kicker">New offer</span><h3>Lock the FT side</h3></div><span className="step-badge">{context ? "Ready" : loaded ? "Redeploy required" : "Loading"}</span></div>
      <div className="dex-form-grid">
        <label className="field field-wide"><span className="field-label">FT asset unit</span><input value={form.fractionUnit} onChange={(event) => update("fractionUnit", event.target.value)} placeholder="Policy ID + asset name in hex" required /></label>
        <label className="field"><span className="field-label">FT units to lock</span><input inputMode="numeric" pattern="[0-9]+" value={form.fractionAmount} onChange={(event) => update("fractionAmount", event.target.value)} required /></label>
        <label className="field"><span className="field-label">Owner LP share (%)</span><input inputMode="decimal" value={form.ownerShare} onChange={(event) => update("ownerShare", event.target.value)} required /><span className="field-hint">The remaining share is minted to the liquidity provider.</span></label>
      </div>
      <fieldset className="dex-quote-choice"><legend>Quote side</legend><div className="segmented-control"><button type="button" className={form.quoteKind === "ada" ? "selected" : ""} onClick={() => update("quoteKind", "ada")}>tADA</button><button type="button" className={form.quoteKind === "usdcx" ? "selected" : ""} onClick={() => update("quoteKind", "usdcx")}>USDCx</button></div><div className="dex-form-grid">{form.quoteKind === "usdcx" && <label className="field field-wide"><span className="field-label">USDCx asset unit</span><input value={form.usdcxUnit} onChange={(event) => update("usdcxUnit", event.target.value)} placeholder="Policy ID + asset name in hex" required /></label>}<label className="field"><span className="field-label">{form.quoteKind === "ada" ? "Final tADA reserve" : "Final USDCx reserve"}</span><input inputMode="numeric" pattern="[0-9]+" value={form.quoteAmount} onChange={(event) => update("quoteAmount", event.target.value)} required /><span className="field-hint">{form.quoteKind === "ada" ? "Whole tADA; the provider funds the balance after the locked buffer." : "Smallest USDCx units; the provider funds the full quote reserve."}</span></label><label className="field"><span className="field-label">Pool ADA buffer</span><input inputMode="numeric" pattern="[0-9]+" value={form.poolAda} onChange={(event) => update("poolAda", event.target.value)} required /><span className="field-hint">At least 2 tADA, locked with the FT to keep the escrow and token/token pool valid.</span></label></div></fieldset>
      <div className="form-footer"><p><span className="status-dot" />{lucid ? " Eternl connected — review the on-chain terms before signing." : " Connect Eternl to lock the FT side."}</p>{!lucid ? <button type="button" className="primary-button" onClick={() => void connect()} disabled={loading}>Connect wallet</button> : <button type="submit" className="primary-button" disabled={loading || !context}>{loading ? "Awaiting wallet…" : "Create bootstrap offer"} <span className="button-arrow">↗</span></button>}</div>
    </form>
    {message && <p className={"form-message " + (message.kind === "error" ? "error-message" : "success-message")} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
    <div className="dex-bootstrap-book"><div className="dex-pools-head"><div><span className="section-kicker">Open offers</span><h3>Awaiting a quote-side provider</h3></div><span className="marketplace-count">{loaded ? offerSummary.length + " open" : "Loading"}</span></div>{!context && loaded && <p className="dex-warning">This DEX deployment predates two-party bootstrap offers. Run the reviewed Preprod redeploy before posting or accepting offers.</p>}{context && !lucid && <p className="dex-empty">Connect Eternl to inspect offers and take part.</p>}{context && lucid && loaded && offerSummary.length === 0 && <p className="dex-empty">No FT bootstrap offers are currently open.</p>}{offerSummary.map(({ offer, liquidity, ownerLp }) => <article className="dex-bootstrap-offer" key={offer.id}><div><span className="marketplace-badge">FT owner escrow</span><strong>{displayAsset(offer.fraction)} · {format(offer.fractionAmount)} units</strong><code>{assetUnit(offer.fraction)}</code></div><dl><div><dt>Quote reserve</dt><dd>{format(offer.quoteAmount)} {displayAsset(offer.quote)}</dd></div><div><dt>Initial LP supply</dt><dd>{format(liquidity)}</dd></div><div><dt>Owner / provider</dt><dd>{Number(offer.ownerShareBps) / 100}% / {100 - Number(offer.ownerShareBps) / 100}%</dd></div><div><dt>LP allocation</dt><dd>{format(ownerLp)} / {format(liquidity - ownerLp)}</dd></div></dl><div className="dex-bootstrap-offer-actions">{offer.managed ? <button type="button" onClick={() => void cancel(offer)} disabled={loading}>Cancel offer</button> : !lucid ? <button type="button" onClick={() => void connect()} disabled={loading}>Connect to fund</button> : <button type="button" className="primary-button" onClick={() => void accept(offer)} disabled={loading}>Fund & create pool <span className="button-arrow">↗</span></button>}</div></article>)}</div>
  </section>;
}
