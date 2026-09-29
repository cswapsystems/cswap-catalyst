"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "./wallet-context";
import { assertWalletSession, isWalletChangedError } from "@/lib/wallet-guard";
import { formatAda } from "@/lib/ada";
import { decodeCardanoAddress } from "@/lib/address-codec";
import { confirmTransaction } from "@/lib/transaction-confirmation";
import { assertBootstrapMinimumAda } from "@/lib/bootstrap-values";
import { summarizeWalletAssets, type WalletAsset } from "@/lib/wallet-assets";

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
  providerAddress: string | null;
  providerKey: string | null;
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
  poolAda: "4",
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
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length < 56 || normalized.length > 120 || normalized.length % 2 !== 0) throw new Error(label + " must be a policy ID plus an asset name of at most 32 bytes in hexadecimal.");
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

function formatUnitPrice(quoteAmount: bigint, fractionAmount: bigint) {
  const precision = BigInt(1_000_000_000_000);
  const scaled = quoteAmount * precision / fractionAmount;
  if (scaled === BigInt(0)) return "< 0.000000000001";
  const whole = format(scaled / precision);
  const decimal = (scaled % precision).toString().padStart(12, "0").replace(/0+$/, "");
  const rounded = quoteAmount * precision % fractionAmount !== BigInt(0);
  return `${rounded ? "≈ " : ""}${whole}${decimal ? "." + decimal : ""}`;
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
  if (!/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/.test(value)) throw new Error("Owner LP share must be between 0.01% and 100%.");
  const [whole, decimal = ""] = value.split(".");
  const bps = BigInt(whole) * BigInt(100) + BigInt((decimal + "00").slice(0, 2));
  if (bps <= BigInt(0) || bps > BigInt(10_000)) throw new Error("Owner LP share must be between 0.01% and 100%.");
  return bps;
}

function decodeOffer(tools: Tools, utxo: import("@lucid-evolution/lucid").UTxO, managedKey?: string): Offer {
  if (!utxo.datum) throw new Error("Bootstrap offer has no inline datum.");
  const escrow = asConstr(tools.Data.from(utxo.datum), "bootstrap escrow");
  if (escrow.index !== 0 && escrow.index !== 1 || escrow.fields.length !== (escrow.index === 0 ? 1 : 3)) throw new Error("Malformed bootstrap escrow state.");
  const datum = asConstr(escrow.fields[0], "bootstrap offer");
  if (datum.index !== 0 || datum.fields.length !== 9 || typeof datum.fields[1] !== "string" || typeof datum.fields[4] !== "bigint" || typeof datum.fields[6] !== "bigint" || typeof datum.fields[7] !== "bigint" || typeof datum.fields[8] !== "bigint") throw new Error("Malformed bootstrap offer datum.");
  const providerAddress = escrow.index === 1 ? decodeCardanoAddress(escrow.fields[1], tools) : null;
  const providerKey = escrow.index === 1 && typeof escrow.fields[2] === "string" ? escrow.fields[2] : null;
  if (escrow.index === 1 && !providerKey) throw new Error("Malformed funded escrow provider.");
  if (providerAddress && tools.getAddressDetails(providerAddress).paymentCredential?.hash !== providerKey) throw new Error("Funded escrow provider identity mismatch.");
  const ownerKey = datum.fields[1];
  const owner = decodeCardanoAddress(datum.fields[0], tools);
  if (tools.getAddressDetails(owner).paymentCredential?.hash !== ownerKey) throw new Error("Bootstrap owner identity mismatch.");
  if (datum.fields[4] <= BigInt(0) || datum.fields[6] <= BigInt(0) || datum.fields[7] < BigInt(2_000_000) || datum.fields[8] <= BigInt(0) || datum.fields[8] > BigInt(10_000)) throw new Error("Invalid offer terms.");
  const fraction = assetFrom(datum.fields[3], "fraction");
  const quote = assetFrom(datum.fields[5], "quote");
  const expected = providerAddress
    ? quote.policyId ? { lovelace: datum.fields[7], [assetUnit(fraction)]: datum.fields[4], [assetUnit(quote)]: datum.fields[6] } : { lovelace: datum.fields[6], [assetUnit(fraction)]: datum.fields[4] }
    : { lovelace: datum.fields[7], [assetUnit(fraction)]: datum.fields[4] };
  if (Object.keys(expected).length !== Object.keys(utxo.assets).length || Object.entries(expected).some(([unit, amount]) => utxo.assets[unit] !== amount)) throw new Error("Bootstrap escrow value does not match its state.");
  return {
    id: utxo.txHash + "#" + utxo.outputIndex,
    utxo,
    owner,
    ownerKey,
    factoryToken: assetFrom(datum.fields[2], "factory token"),
    fraction,
    fractionAmount: datum.fields[4],
    quote,
    quoteAmount: datum.fields[6],
    poolLovelace: datum.fields[7],
    ownerShareBps: datum.fields[8],
    managed: ownerKey === managedKey,
    providerAddress,
    providerKey,
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
  if (deployment.bootstrapOfferAddress !== bootstrapAddress || tools.validatorToAddress("Preprod", factory) !== deployment.factoryAddress || tools.validatorToAddress("Preprod", amm) !== deployment.ammAddress || tools.mintingPolicyToId(lp) !== deployment.lpPolicyId || tools.mintingPolicyToId(poolFactory) !== deployment.poolPolicyId) throw new Error("DEX deployment must be redeployed for the three-party bootstrap validators.");
  return { deployment, bootstrapAddress, scripts: { offer, factory, amm, lp, poolFactory } };
}

export default function DexBootstrapWorkbench() {
  const { address, lucid, connect, disconnect } = useWallet();
  const [context, setContext] = useState<Context | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [walletAssets, setWalletAssets] = useState<{ address: string; assets: WalletAsset[] } | null>(null);
  const [isTeam, setIsTeam] = useState(false);
  const [form, setForm] = useState<Form>(initialForm);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pendingHash, setPendingHash] = useState("");
  // Survives the disconnect-triggered refresh so the user sees why a reconnect is required.
  const [sessionError, setSessionError] = useState("");

  // On an account/network change, discard wallet-specific state and reconnect.
  function handleSessionChange(cause: unknown) {
    if (!isWalletChangedError(cause)) return false;
    setOffers([]); setSessionError(cause.message); disconnect();
    setWalletAssets(null);
    return true;
  }

  const refresh = useCallback(async () => {
    setMessage(null);
    setLoading(true);
    setWalletAssets(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const next = await loadContext(tools);
      setContext(next);
      if (!lucid) {
        setOffers([]);
        setIsTeam(false);
        return;
      }
      setSessionError("");
      if (!address) throw new Error("Connect Eternl to read your FT holdings.");
      await assertWalletSession(lucid, address);
      const assets = summarizeWalletAssets(await lucid.wallet().getUtxos()).assets;
      await assertWalletSession(lucid, address);
      setWalletAssets({ address, assets });
      const ownerKey = address && tools.getAddressDetails(address).paymentCredential?.type === "Key" ? tools.getAddressDetails(address).paymentCredential?.hash : undefined;
      setIsTeam(ownerKey === next.deployment.admin);
      const found: Offer[] = [];
      for (const utxo of await lucid.utxosAt(next.bootstrapAddress)) {
        try {
          const offer = decodeOffer(tools, utxo, ownerKey);
          if (assetUnit(offer.factoryToken) === next.deployment.factoryToken) found.push(offer);
        } catch {
          // Ignore any unrelated UTxO sent to the offer script.
        }
      }
      setOffers(found);
    } catch (cause) {
      setContext(null);
      setOffers([]);
      setIsTeam(false);
      setWalletAssets(null);
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

  async function checkConfirmation(hash = pendingHash) {
    if (!lucid || !hash) return;
    setLoading(true);
    try {
      if (!await confirmTransaction(lucid, hash)) throw new Error("Confirmation is still pending: " + hash);
      await refresh();
      setPendingHash("");
      setMessage({ kind: "success", text: "Transaction confirmed: " + hash });
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to check confirmation: " + hash });
    } finally { setLoading(false); }
  }

  async function submitOffer(event: FormEvent) {
    event.preventDefault();
    if (!lucid || !address || !context) {
      setMessage({ kind: "error", text: "Connect Eternl and load the redeployed DEX before creating an offer." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await assertWalletSession(lucid, address);
      const tools = await import("@lucid-evolution/lucid");
      const details = tools.getAddressDetails(address);
      if (details.paymentCredential?.type !== "Key") throw new Error("The FT-owner wallet needs a payment-key address.");
      if (details.paymentCredential.hash === context.deployment.admin) throw new Error("The FT provider must be distinct from the Team creator.");
      const fraction = parseUnit(form.fractionUnit, "FT asset unit");
      if (!walletAssets || walletAssets.address !== address || !walletAssets.assets.some((asset) => asset.unit === form.fractionUnit)) throw new Error("Select an FT from the connected wallet.");
      const quote = form.quoteKind === "ada" ? { policyId: "", assetName: "" } : parseUnit(form.usdcxUnit, "USDCx asset unit");
      if (assetUnit(fraction) === assetUnit(quote)) throw new Error("FT and quote assets must be different.");
      const fractionAmount = BigInt(form.fractionAmount);
      const currentAssets = summarizeWalletAssets(await lucid.wallet().getUtxos()).assets;
      await assertWalletSession(lucid, address);
      if ((currentAssets.find((asset) => asset.unit === form.fractionUnit)?.quantity ?? BigInt(0)) < fractionAmount) throw new Error("The selected wallet does not hold enough FT units. Refresh assets and choose an available amount.");
      const quoteAmount = BigInt(form.quoteAmount) * (quote.policyId ? BigInt(1) : BigInt(1_000_000));
      const poolLovelace = BigInt(form.poolAda) * BigInt(1_000_000);
      const ownerShareBps = parseShareBps(form.ownerShare);
      if (fractionAmount <= BigInt(0) || quoteAmount <= BigInt(0) || poolLovelace < BigInt(2_000_000)) throw new Error("Use a positive FT amount, positive quote reserve, and an ADA buffer of at least 2.");
      if (!quote.policyId && poolLovelace > quoteAmount) throw new Error("The ADA reserve must be at least as large as the locked ADA buffer.");
      const liquidity = integerSqrt(fractionAmount * quoteAmount);
      const ownerLp = liquidity * ownerShareBps / BigInt(10_000);
      if (ownerLp <= BigInt(0) || ownerLp > liquidity || ownerShareBps < BigInt(10_000) && ownerLp === liquidity) throw new Error("Increase reserves or adjust the split so each declared recipient receives LP tokens.");
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
      const name = poolName(BigInt(0)); // Every pool ID is encoded as exactly 8 bytes.
      const poolNft = { policyId: context.deployment.poolPolicyId, assetName: name };
      const lpToken = { policyId: context.deployment.lpPolicyId, assetName: name };
      const poolValue = quote.policyId ? poolLovelace : quoteAmount;
      const poolDatum = new tools.Constr(0, [assetData(tools, poolNft), assetData(tools, quote), assetData(tools, fraction), assetData(tools, lpToken), BigInt(997), BigInt(1000), quoteAmount, fractionAmount, liquidity, poolValue]);
      const parameters = lucid.config().protocolParameters;
      if (!parameters) throw new Error("Network protocol parameters are unavailable.");
      const offerDatum = tools.Data.to(new tools.Constr(0, [datum]) as import("@lucid-evolution/lucid").Data);
      const offerAssets = { lovelace: poolLovelace, [assetUnit(fraction)]: fractionAmount };
      assertBootstrapMinimumAda(tools, parameters.coinsPerUtxoByte, [
        { label: "Offer escrow", address: context.bootstrapAddress, datum: offerDatum, assets: offerAssets },
        { label: "Resulting pool", address: context.deployment.ammAddress, datum: tools.Data.to(poolDatum), assets: quote.policyId ? { lovelace: poolValue, [assetUnit(quote)]: quoteAmount, [assetUnit(fraction)]: fractionAmount, [assetUnit(poolNft)]: BigInt(1) } : { lovelace: poolValue, [assetUnit(fraction)]: fractionAmount, [assetUnit(poolNft)]: BigInt(1) } },
      ]);
      const tx = lucid.newTx()
        .pay.ToContract(context.bootstrapAddress, { kind: "inline", value: offerDatum }, offerAssets)
        .addSigner(address);
      const completed = await tx.complete();
      await assertWalletSession(lucid, address);
      const hash = await (await completed.sign.withWallet().complete()).submit();
      setPendingHash(hash);
      setForm(initialForm);
      await checkConfirmation(hash);
    } catch (cause) {
      if (handleSessionChange(cause)) return;
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The bootstrap offer could not be submitted." });
    } finally {
      setLoading(false);
    }
  }

  async function fund(offer: Offer) {
    if (!lucid || !address || !context || offer.providerAddress) {
      setMessage({ kind: "error", text: "Connect a liquidity-provider wallet and select an open offer." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await assertWalletSession(lucid, address);
      const tools = await import("@lucid-evolution/lucid");
      const provider = tools.getAddressDetails(address).paymentCredential;
      if (!provider || provider.type !== "Key") throw new Error("The liquidity-provider wallet needs a payment-key address.");
      if (provider.hash === context.deployment.admin) throw new Error("The Team creator cannot fund an offer.");
      const selfFunded = offer.ownerShareBps === BigInt(10_000);
      if (selfFunded ? address !== offer.owner || provider.hash !== offer.ownerKey : provider.hash === offer.ownerKey) throw new Error(selfFunded ? "Only the FT owner can fund a 100% LP offer." : "This split offer needs a separate liquidity-provider wallet.");
      const factoryState = await lucid.utxoByUnit(context.deployment.factoryToken);
      if (!factoryState.datum) throw new Error("Factory state datum is missing.");
      const factory = asConstr(tools.Data.from(factoryState.datum), "factory state");
      if (factory.index !== 0 || factory.fields.length !== 5 || factory.fields[1] !== context.deployment.admin || assetUnit(assetFrom(factory.fields[0], "factory token")) !== context.deployment.factoryToken || asConstr(factory.fields[4], "factory pause state").index !== 0) throw new Error("The factory state is invalid or paused.");
      const liquidity = integerSqrt(offer.quoteAmount * offer.fractionAmount);
      const ownerLp = liquidity * offer.ownerShareBps / BigInt(10_000);
      if (ownerLp <= BigInt(0) || (selfFunded ? ownerLp !== liquidity : ownerLp >= liquidity)) throw new Error("The reserves do not yield the declared LP allocation.");
      const open = asConstr(tools.Data.from(offer.utxo.datum!), "open escrow");
      if (open.index !== 0 || open.fields.length !== 1) throw new Error("This offer is no longer open. Refresh offers.");
      const fundedDatum = tools.Data.to(new tools.Constr(1, [open.fields[0], addressData(tools, address), provider.hash]) as import("@lucid-evolution/lucid").Data);
      const fundedAssets = offer.quote.policyId
        ? { lovelace: offer.poolLovelace, [assetUnit(offer.fraction)]: offer.fractionAmount, [assetUnit(offer.quote)]: offer.quoteAmount }
        : { lovelace: offer.quoteAmount, [assetUnit(offer.fraction)]: offer.fractionAmount };
      const parameters = lucid.config().protocolParameters;
      if (!parameters) throw new Error("Network protocol parameters are unavailable.");
      assertBootstrapMinimumAda(tools, parameters.coinsPerUtxoByte, [{ label: "Funded escrow", address: context.bootstrapAddress, datum: fundedDatum, assets: fundedAssets }]);
      const tx = lucid.newTx()
        .collectFrom([offer.utxo], tools.Data.to(new tools.Constr(0, [addressData(tools, address), provider.hash]) as import("@lucid-evolution/lucid").Data))
        .readFrom([factoryState])
        .attach.SpendingValidator(context.scripts.offer)
        .pay.ToContract(context.bootstrapAddress, { kind: "inline", value: fundedDatum }, fundedAssets)
        .addSigner(address);
      const completed = await tx.complete();
      await assertWalletSession(lucid, address);
      const hash = await (await completed.sign.withWallet().complete()).submit();
      setPendingHash(hash);
      await checkConfirmation(hash);
    } catch (cause) {
      if (handleSessionChange(cause)) return;
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The quote deposit could not be submitted." });
    } finally { setLoading(false); }
  }

  async function finalize(offer: Offer) {
    if (!lucid || !address || !context || !offer.providerAddress || !offer.providerKey) {
      setMessage({ kind: "error", text: "Connect the Team creator wallet and select a funded escrow." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await assertWalletSession(lucid, address);
      const tools = await import("@lucid-evolution/lucid");
      const team = tools.getAddressDetails(address).paymentCredential;
      if (!team || team.type !== "Key" || team.hash !== context.deployment.admin) throw new Error("Only the configured Team creator can create this pool.");
      const fresh = await lucid.utxosByOutRef([{ txHash: offer.utxo.txHash, outputIndex: offer.utxo.outputIndex }]);
      if (fresh.length !== 1 || fresh[0].datum !== offer.utxo.datum) throw new Error("The funded escrow changed. Refresh before signing.");
      const factoryState = await lucid.utxoByUnit(context.deployment.factoryToken);
      if (!factoryState.datum) throw new Error("Factory state datum is missing.");
      const before = asConstr(tools.Data.from(factoryState.datum), "factory state");
      if (before.index !== 0 || before.fields.length !== 5 || typeof before.fields[3] !== "bigint" || before.fields[1] !== team.hash || asConstr(before.fields[4], "factory pause state").index !== 0) throw new Error("The factory state is invalid or paused.");
      if (assetUnit(assetFrom(before.fields[0], "factory token")) !== context.deployment.factoryToken) throw new Error("Factory state token mismatch.");
      const name = poolName(before.fields[3]);
      const poolNft = { policyId: context.deployment.poolPolicyId, assetName: name };
      const lpToken = { policyId: context.deployment.lpPolicyId, assetName: name };
      const liquidity = integerSqrt(offer.quoteAmount * offer.fractionAmount);
      const ownerLp = liquidity * offer.ownerShareBps / BigInt(10_000);
      const providerLp = liquidity - ownerLp;
      if (ownerLp <= BigInt(0) || (offer.ownerShareBps === BigInt(10_000) ? providerLp !== BigInt(0) || offer.providerAddress !== offer.owner : providerLp <= BigInt(0) || offer.providerKey === offer.ownerKey)) throw new Error("The funded escrow does not match its LP allocation.");
      const poolLovelace = offer.quote.policyId ? offer.poolLovelace : offer.quoteAmount;
      const after = new tools.Constr(0, [before.fields[0], before.fields[1], before.fields[2], before.fields[3] + BigInt(1), before.fields[4]]);
      const pool = new tools.Constr(0, [assetData(tools, poolNft), assetData(tools, offer.quote), assetData(tools, offer.fraction), assetData(tools, lpToken), BigInt(997), BigInt(1000), offer.quoteAmount, offer.fractionAmount, liquidity, poolLovelace]);
      const poolAssets = offer.quote.policyId
        ? { lovelace: poolLovelace, [assetUnit(offer.quote)]: offer.quoteAmount, [assetUnit(offer.fraction)]: offer.fractionAmount, [assetUnit(poolNft)]: BigInt(1) }
        : { lovelace: poolLovelace, [assetUnit(offer.fraction)]: offer.fractionAmount, [assetUnit(poolNft)]: BigInt(1) };
      let tx = lucid.newTx()
        .collectFrom(fresh, tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data))
        .collectFrom([factoryState], tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data))
        .mintAssets({ [assetUnit(poolNft)]: BigInt(1) }, tools.Data.to(new tools.Constr(0, []) as import("@lucid-evolution/lucid").Data))
        .mintAssets({ [assetUnit(lpToken)]: liquidity }, tools.Data.to(new tools.Constr(0, [assetData(tools, poolNft)]) as import("@lucid-evolution/lucid").Data))
        .attach.SpendingValidator(context.scripts.offer)
        .attach.SpendingValidator(context.scripts.factory)
        .attach.MintingPolicy(context.scripts.poolFactory)
        .attach.MintingPolicy(context.scripts.lp)
        .pay.ToContract(context.deployment.factoryAddress, { kind: "inline", value: tools.Data.to(after as import("@lucid-evolution/lucid").Data) }, { ...factoryState.assets })
        .pay.ToContract(context.deployment.ammAddress, { kind: "inline", value: tools.Data.to(pool as import("@lucid-evolution/lucid").Data) }, poolAssets)
        .pay.ToAddress(offer.owner, { [assetUnit(lpToken)]: ownerLp });
      if (providerLp > BigInt(0)) tx = tx.pay.ToAddress(offer.providerAddress, { [assetUnit(lpToken)]: providerLp });
      tx = tx.addSigner(address);
      const completed = await tx.complete();
      await assertWalletSession(lucid, address);
      const hash = await (await completed.sign.withWallet().complete()).submit();
      setPendingHash(hash);
      await checkConfirmation(hash);
    } catch (cause) {
      if (handleSessionChange(cause)) return;
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The funded pool could not be created." });
    } finally { setLoading(false); }
  }

  async function cancel(offer: Offer) {
    if (!lucid || !address || !context || !offer.managed) {
      setMessage({ kind: "error", text: "Connect the FT-owner wallet to cancel this offer." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await assertWalletSession(lucid, address);
      const tools = await import("@lucid-evolution/lucid");
      const tx = lucid.newTx()
        .collectFrom([offer.utxo], tools.Data.to(new tools.Constr(2, []) as import("@lucid-evolution/lucid").Data))
        .attach.SpendingValidator(context.scripts.offer)
        .pay.ToAddress(offer.owner, { ...offer.utxo.assets })
        .addSigner(address);
      const completed = await tx.complete();
      await assertWalletSession(lucid, address);
      const hash = await (await completed.sign.withWallet().complete()).submit();
      setPendingHash(hash);
      await checkConfirmation(hash);
    } catch (cause) {
      if (handleSessionChange(cause)) return;
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The offer could not be cancelled." });
    } finally {
      setLoading(false);
    }
  }

  const offerSummary = useMemo(() => offers.map((offer) => {
    const liquidity = integerSqrt(offer.quoteAmount * offer.fractionAmount);
    return { offer, liquidity, ownerLp: liquidity * offer.ownerShareBps / BigInt(10_000) };
  }), [offers]);
  const availableAssets = walletAssets?.address === address ? walletAssets.assets : [];
  const selectedAsset = availableAssets.find((asset) => asset.unit === form.fractionUnit);
  const priceInputsValid = /^\d+$/.test(form.fractionAmount) && /^\d+$/.test(form.quoteAmount) && BigInt(form.fractionAmount) > BigInt(0) && BigInt(form.quoteAmount) > BigInt(0);
  const startingPrice = priceInputsValid ? formatUnitPrice(BigInt(form.quoteAmount), BigInt(form.fractionAmount)) : null;

  return <section className="dex-bootstrap">
    <div className="dex-bootstrap-head">
      <div><span className="section-kicker">Three-party liquidity launch</span><h2>FT provider, liquidity provider, and Team creator</h2></div>
      <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh offers"}</button>
    </div>
    <p className="dex-intro">The FT provider locks fraction tokens on-chain. The FT owner or a separate LP then adds the quote reserve, and the Team creator spends the funded escrow to create the pool.</p>
    <ol className="dex-bootstrap-steps">
      <li><span>01</span><div><strong>FT provider locks an offer</strong><p>FT quantity, quote reserve, ADA buffer, and LP split are fixed in the datum.</p></div></li>
      <li><span>02</span><div><strong>Quote provider funds</strong><p>The FT owner may fund a 100% LP offer; split offers require a separate wallet.</p></div></li>
      <li><span>03</span><div><strong>Team creator approves</strong><p>The factory creator spends the funded escrow and creates the pool with one Team-signed transaction.</p></div></li>
    </ol>
    {pendingHash && <p className="dex-warning" role="status">Transaction submitted: <code>{pendingHash}</code>. Check confirmation before retrying. <button type="button" onClick={() => void checkConfirmation()} disabled={loading}>Check confirmation</button></p>}
    <fieldset className="module-fieldset" disabled={loading || Boolean(pendingHash)}>
    <form className="dex-bootstrap-form" onSubmit={submitOffer}>
      <div className="section-heading"><div><span className="section-kicker">Step 1 · FT provider</span><h3>Lock the FT side</h3></div><span className="step-badge">{context ? "Ready" : loaded ? "Redeploy required" : "Loading"}</span></div>
      <div className="dex-form-grid">
        <label className="field field-wide"><span className="field-label">FT asset unit</span><span className="field-input-wrap"><select value={selectedAsset ? form.fractionUnit : ""} onChange={(event) => update("fractionUnit", event.target.value)} disabled={!lucid || !walletAssets || availableAssets.length === 0} required><option value="" disabled>{!lucid ? "Connect Eternl to select an FT" : !walletAssets ? "Loading wallet assets…" : "Select an asset from your wallet"}</option>{availableAssets.map((asset) => <option key={asset.unit} value={asset.unit}>{asset.name} · {format(asset.quantity)} units · {asset.policyId.slice(0, 12)}…{asset.unit.slice(-8)}</option>)}</select><span className="select-chevron" aria-hidden="true">⌄</span></span>{selectedAsset && <span className="field-hint">Selected asset: <code>{selectedAsset.unit}</code></span>}{walletAssets && availableAssets.length === 0 && <span className="field-hint">No native tokens are available in this wallet. Refresh offers after receiving FT units.</span>}</label>
        <label className="field"><span className="field-label">FT units to lock</span><input inputMode="numeric" pattern="[0-9]+" value={form.fractionAmount} onChange={(event) => update("fractionAmount", event.target.value)} required /></label>
        <label className="field"><span className="field-label">FT owner LP share (%)</span><input inputMode="decimal" value={form.ownerShare} onChange={(event) => update("ownerShare", event.target.value)} required /><span className="field-hint">Set 100% to deposit the quote side yourself and receive all LP tokens. A smaller share requires a separate liquidity provider.</span></label>
      </div>
      <fieldset className="dex-quote-choice"><legend>Quote side</legend><div className="segmented-control"><button type="button" className={form.quoteKind === "ada" ? "selected" : ""} onClick={() => update("quoteKind", "ada")}>tADA</button><button type="button" className={form.quoteKind === "usdcx" ? "selected" : ""} onClick={() => update("quoteKind", "usdcx")}>USDCx</button></div><div className="dex-form-grid">{form.quoteKind === "usdcx" && <label className="field field-wide"><span className="field-label">USDCx asset unit</span><input value={form.usdcxUnit} onChange={(event) => update("usdcxUnit", event.target.value)} placeholder="Policy ID + asset name in hex" required /></label>}<label className="field"><span className="field-label">{form.quoteKind === "ada" ? "Final tADA reserve" : "Final USDCx reserve"}</span><input inputMode="numeric" pattern="[0-9]+" value={form.quoteAmount} onChange={(event) => update("quoteAmount", event.target.value)} required /><span className="field-hint">{form.quoteKind === "ada" ? "Whole tADA; the LP funds the balance after the locked buffer." : "Smallest USDCx units; the LP funds the full quote reserve."}</span></label><label className="field"><span className="field-label">Pool ADA buffer</span><input inputMode="numeric" pattern="[0-9]+" value={form.poolAda} onChange={(event) => update("poolAda", event.target.value)} required /><span className="field-hint">At least 2 tADA, locked with the FT to keep the escrow and token/token pool valid.</span></label></div></fieldset>
      <div className="dex-starting-price" aria-live="polite"><span>Starting pool price</span>{startingPrice ? <strong>1 FT = {startingPrice} {form.quoteKind === "ada" ? "tADA" : "USDCx smallest units"}</strong> : <strong>Enter positive FT and quote reserves</strong>}<p>Based on the final quote reserve divided by FT units. The ADA buffer is part of the tADA reserve; swaps and fees change the execution price.</p></div>
      <div className="form-footer"><p><span className="status-dot" />{lucid ? " Eternl connected — review the on-chain terms before signing." : " Connect Eternl to lock the FT side."}</p>{!lucid ? <button type="button" className="primary-button" onClick={() => void connect()} disabled={loading}>Connect wallet</button> : <button type="submit" className="primary-button" disabled={loading || !context || availableAssets.length === 0}>{loading ? "Awaiting wallet…" : "Create bootstrap offer"} <span className="button-arrow">↗</span></button>}</div>
    </form>
    {sessionError && <p className="form-message error-message" role="alert">{sessionError}</p>}
    {message && <p className={"form-message " + (message.kind === "error" ? "error-message" : "success-message")} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
    <section className="dex-bootstrap-book" aria-labelledby="dex-bootstrap-offers-title">
      <div className="dex-pools-head"><div><span className="section-kicker">Step 2 · liquidity provider</span><h3 id="dex-bootstrap-offers-title">Fund an open offer</h3></div><span className="marketplace-count">{loaded ? offers.filter((offer) => !offer.providerAddress).length + " open" : "Loading"}</span></div>
      <p className="dex-intro">The FT owner funds a 100% LP offer; a separate liquidity provider funds a split offer. After confirmation, the FT owner can no longer cancel.</p>
      {!context && loaded && <p className="dex-warning">This DEX deployment needs the funded-escrow validator migration before offers can be created or funded.</p>}
      {context && !lucid && <p className="dex-empty">Connect Eternl to inspect offers and take part.</p>}
      {context && lucid && loaded && !offers.some((offer) => !offer.providerAddress) && <p className="dex-empty">No open FT offers are available to fund.</p>}
      {offerSummary.filter(({ offer }) => !offer.providerAddress).map(({ offer, liquidity, ownerLp }) => <article className="dex-bootstrap-offer" key={offer.id}>
        <div><span className="marketplace-badge">Open FT escrow</span><strong>{displayAsset(offer.fraction)} · {format(offer.fractionAmount)} units</strong><code>{assetUnit(offer.fraction)}</code></div>
        <dl><div><dt>Quote to deposit</dt><dd>{offer.quote.policyId ? format(offer.quoteAmount) : formatAda(offer.quoteAmount - offer.poolLovelace)} {displayAsset(offer.quote)}</dd></div><div><dt>Quote asset unit</dt><dd><code>{assetUnit(offer.quote)}</code></dd></div><div><dt>Initial LP supply</dt><dd>{format(liquidity)}</dd></div><div><dt>FT provider / LP</dt><dd>{Number(offer.ownerShareBps) / 100}% / {100 - Number(offer.ownerShareBps) / 100}%</dd></div><div><dt>LP allocation</dt><dd>{format(ownerLp)} / {format(liquidity - ownerLp)}</dd></div></dl>
        <div className="dex-bootstrap-offer-actions">{offer.managed && <button type="button" onClick={() => void cancel(offer)} disabled={loading}>Cancel open offer</button>}{(offer.ownerShareBps === BigInt(10_000) ? offer.managed : !offer.managed) && <button type="button" className="primary-button" onClick={() => void fund(offer)} disabled={loading || !lucid || isTeam}>{offer.managed ? "Fund your offer" : "Deposit quote into escrow"} <span className="button-arrow">↗</span></button>}{!offer.managed && offer.ownerShareBps === BigInt(10_000) && <span className="dex-empty">Only the FT owner can fund this offer.</span>}</div>
      </article>)}
    </section>
    <section className="dex-bootstrap-book" aria-labelledby="dex-bootstrap-funded-title">
      <div className="dex-pools-head"><div><span className="section-kicker">Step 3 · Team creator</span><h3 id="dex-bootstrap-funded-title">Create a pool from a funded escrow</h3></div><span className="marketplace-count">{loaded ? offers.filter((offer) => offer.providerAddress).length + " funded" : "Loading"}</span></div>
      <p className="dex-intro">Both reserves are already locked on-chain. The configured Team creator spends the funded escrow, advances the factory, and pays LP shares to both providers. Neither provider signs this transaction.</p>
      {context && lucid && loaded && !offers.some((offer) => offer.providerAddress) && <p className="dex-empty">No funded escrows are waiting for Team pool creation.</p>}
      {offerSummary.filter(({ offer }) => offer.providerAddress).map(({ offer, liquidity, ownerLp }) => <article className="dex-bootstrap-offer" key={offer.id}>
        <div><span className="marketplace-badge">Funded on-chain</span><strong>{displayAsset(offer.fraction)} · {format(offer.fractionAmount)} FT units</strong><code>{assetUnit(offer.fraction)}</code></div>
        <dl><div><dt>Quote reserve</dt><dd>{offer.quote.policyId ? format(offer.quoteAmount) : formatAda(offer.quoteAmount)} {displayAsset(offer.quote)} · <code>{assetUnit(offer.quote)}</code></dd></div><div><dt>Locked ADA buffer</dt><dd>{formatAda(offer.poolLovelace)} tADA</dd></div><div><dt>FT provider</dt><dd><code>{offer.owner}</code></dd></div><div><dt>Liquidity provider</dt><dd><code>{offer.providerAddress}</code></dd></div><div><dt>LP allocation</dt><dd>{format(ownerLp)} / {format(liquidity - ownerLp)}</dd></div></dl>
        <div className="dex-bootstrap-offer-actions">{isTeam ? <button type="button" className="primary-button" onClick={() => void finalize(offer)} disabled={loading}>Create pool <span className="button-arrow">↗</span></button> : <span className="dex-empty">Awaiting the configured Team creator wallet.</span>}</div>
      </article>)}
    </section>
    </fieldset>
  </section>;
}
