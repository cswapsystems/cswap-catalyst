"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "./wallet-context";
import { assertWalletSession, isWalletChangedError } from "@/lib/wallet-guard";
import { formatAda } from "@/lib/ada";
import { reviewBootstrapTransaction } from "@/lib/bootstrap-review";
import { decodeCardanoAddress } from "@/lib/address-codec";
import { confirmTransaction } from "@/lib/transaction-confirmation";
import { assertBootstrapMinimumAda } from "@/lib/bootstrap-values";

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
type ApprovalRequest = {
  offerId: string;
  transactionCbor: string;
  providerWitness: string;
  providerAddress: string;
};
type TeamReview = Awaited<ReturnType<typeof reviewBootstrapTransaction>>;

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
  if (datum.fields[4] <= BigInt(0) || datum.fields[6] <= BigInt(0) || datum.fields[7] < BigInt(2_000_000) || datum.fields[8] <= BigInt(0) || datum.fields[8] >= BigInt(10_000)) throw new Error("Invalid offer terms.");
  return {
    id: utxo.txHash + "#" + utxo.outputIndex,
    utxo,
    owner: decodeCardanoAddress(datum.fields[0], tools),
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
  if (deployment.bootstrapOfferAddress !== bootstrapAddress || tools.validatorToAddress("Preprod", factory) !== deployment.factoryAddress || tools.validatorToAddress("Preprod", amm) !== deployment.ammAddress || tools.mintingPolicyToId(lp) !== deployment.lpPolicyId || tools.mintingPolicyToId(poolFactory) !== deployment.poolPolicyId) throw new Error("DEX deployment must be redeployed for the three-party bootstrap validators.");
  return { deployment, bootstrapAddress, scripts: { offer, factory, amm, lp, poolFactory } };
}

export default function DexBootstrapWorkbench() {
  const { address, lucid, connect, disconnect } = useWallet();
  const [context, setContext] = useState<Context | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [form, setForm] = useState<Form>(initialForm);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const [teamTransaction, setTeamTransaction] = useState("");
  const [teamWitness, setTeamWitness] = useState("");
  const [teamReview, setTeamReview] = useState<TeamReview | null>(null);
  const [teamAcknowledged, setTeamAcknowledged] = useState(false);
  const [returnedTeamWitness, setReturnedTeamWitness] = useState("");
  const [pendingHash, setPendingHash] = useState("");
  // Survives the disconnect-triggered refresh so the user sees why a reconnect is required.
  const [sessionError, setSessionError] = useState("");

  // R07: on an account/network change, drop every prepared request, review and
  // witness built for the previous account and require an explicit reconnect.
  function handleSessionChange(cause: unknown) {
    if (!isWalletChangedError(cause)) return false;
    setApprovalRequest(null); setTeamReview(null); setTeamAcknowledged(false); setTeamWitness(""); setReturnedTeamWitness("");
    setOffers([]); setSessionError(cause.message); disconnect();
    return true;
  }

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
      setSessionError("");
      const ownerKey = address && tools.getAddressDetails(address).paymentCredential?.type === "Key" ? tools.getAddressDetails(address).paymentCredential?.hash : undefined;
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
      const quote = form.quoteKind === "ada" ? { policyId: "", assetName: "" } : parseUnit(form.usdcxUnit, "USDCx asset unit");
      if (assetUnit(fraction) === assetUnit(quote)) throw new Error("FT and quote assets must be different.");
      const fractionAmount = BigInt(form.fractionAmount);
      const quoteAmount = BigInt(form.quoteAmount) * (quote.policyId ? BigInt(1) : BigInt(1_000_000));
      const poolLovelace = BigInt(form.poolAda) * BigInt(1_000_000);
      const ownerShareBps = parseShareBps(form.ownerShare);
      if (fractionAmount <= BigInt(0) || quoteAmount <= BigInt(0) || poolLovelace < BigInt(2_000_000)) throw new Error("Use a positive FT amount, positive quote reserve, and an ADA buffer of at least 2.");
      if (!quote.policyId && poolLovelace > quoteAmount) throw new Error("The ADA reserve must be at least as large as the locked ADA buffer.");
      const liquidity = integerSqrt(fractionAmount * quoteAmount);
      const ownerLp = liquidity * ownerShareBps / BigInt(10_000);
      if (ownerLp <= BigInt(0) || ownerLp >= liquidity) throw new Error("Increase reserves or adjust the split so both parties receive LP tokens.");
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
      const offerDatum = tools.Data.to(datum as import("@lucid-evolution/lucid").Data);
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

  async function accept(offer: Offer) {
    if (!lucid || !address || !context) {
      setMessage({ kind: "error", text: "Connect the liquidity-provider wallet before preparing an approval request." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await assertWalletSession(lucid, address);
      const tools = await import("@lucid-evolution/lucid");
      const provider = tools.getAddressDetails(address).paymentCredential;
      if (!provider || provider.type !== "Key") throw new Error("The liquidity-provider wallet needs a payment-key address.");
      if (provider.hash === offer.ownerKey || provider.hash === context.deployment.admin) throw new Error("Use a wallet distinct from the FT provider and Team creator.");
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
      const offerRedeemer = new tools.Constr(0, [addressData(tools, address), provider.hash]);
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
        .addSignerKey(provider.hash)
        .addSignerKey(context.deployment.admin);
      const completed = await tx.complete();
      const reviewed = await reviewBootstrapTransaction(tools, lucid, completed.toCBOR(), context.deployment, decodeCardanoAddress);
      if (!reviewed.result.ok) throw new Error(reviewed.result.issues.join(" "));
      await assertWalletSession(lucid, address);
      const providerWitness = await completed.partialSign.withWallet();
      setApprovalRequest({ offerId: offer.id, transactionCbor: completed.toCBOR(), providerWitness, providerAddress: address });
      setReturnedTeamWitness("");
      setMessage({ kind: "success", text: "Quote-side signature created. Send the approval transaction to the Team creator for review and signature." });
    } catch (cause) {
      if (handleSessionChange(cause)) return;
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The approval request could not be prepared." });
    } finally {
      setLoading(false);
    }
  }

  async function reviewTeamApproval() {
    setTeamWitness("");
    if (!lucid || !address || !context) {
      setMessage({ kind: "error", text: "Connect the configured Team creator wallet before reviewing a bootstrap transaction." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const team = tools.getAddressDetails(address).paymentCredential;
      if (!team || team.type !== "Key" || team.hash !== context.deployment.admin) throw new Error("Only the configured Team creator can review this bootstrap transaction.");
      const transaction = teamTransaction.trim();
      if (!/^[0-9a-f]+$/i.test(transaction)) throw new Error("Paste a valid hexadecimal transaction CBOR value.");
      const review = await reviewBootstrapTransaction(tools, lucid, transaction, context.deployment, decodeCardanoAddress);
      const { result } = review;
      setTeamReview(review);
      setTeamAcknowledged(false);
      setMessage(result.ok ? { kind: "success", text: "Bootstrap request matches the current offer and factory state. Confirm the review before signing." } : { kind: "error", text: result.issues.join(" ") });
    } catch (cause) {
      setTeamReview(null);
      setTeamAcknowledged(false);
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The Team approval request could not be reviewed." });
    } finally {
      setLoading(false);
    }
  }

  async function signTeamApproval() {
    if (!lucid || !address || !context) { setMessage({ kind: "error", text: "Connect the configured Team creator wallet before approving a bootstrap transaction." }); return; }
    const transaction = teamTransaction.trim();
    if (!teamReview || teamReview.transaction !== transaction || !teamReview.result.ok || !teamAcknowledged) { setMessage({ kind: "error", text: "Review the exact bootstrap transaction and confirm its terms before signing." }); return; }
    setLoading(true); setMessage(null);
    try {
      await assertWalletSession(lucid, address);
      const team = (await import("@lucid-evolution/lucid")).getAddressDetails(address).paymentCredential;
      if (!team || team.type !== "Key" || team.hash !== context.deployment.admin) throw new Error("Only the configured Team creator can approve this bootstrap transaction.");
      const fresh = await reviewBootstrapTransaction(await import("@lucid-evolution/lucid"), lucid, transaction, context.deployment, decodeCardanoAddress);
      if (!fresh.result.ok) throw new Error(fresh.result.issues.join(" "));
      await assertWalletSession(lucid, address);
      const witness = await lucid.fromTx(transaction).partialSign.withWallet();
      setTeamWitness(witness);
      setMessage({ kind: "success", text: "Team approval witness created. Return this witness to the liquidity provider for final submission." });
    } catch (cause) { if (handleSessionChange(cause)) return; setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The Team approval could not be created." }); }
    finally { setLoading(false); }
  }

  async function submitTeamApprovedBootstrap() {
    if (!lucid || !approvalRequest || !context) {
      setMessage({ kind: "error", text: "Prepare the quote-side transaction with the liquidity-provider wallet first." });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      // The prepared request pays LP to, and was witnessed by, the provider account.
      await assertWalletSession(lucid, approvalRequest.providerAddress);
      const team = returnedTeamWitness.trim();
      if (!/^[0-9a-f]+$/i.test(team)) throw new Error("Paste the Team creator's hexadecimal witness before submitting.");
      const review = await reviewBootstrapTransaction(await import("@lucid-evolution/lucid"), lucid, approvalRequest.transactionCbor, context.deployment, decodeCardanoAddress);
      if (!review.result.ok) throw new Error(review.result.issues.join(" "));
      const signed = await lucid.fromTx(approvalRequest.transactionCbor)
        .assemble([approvalRequest.providerWitness, team])
        .complete();
      await assertWalletSession(lucid, approvalRequest.providerAddress);
      const hash = await signed.submit();
      setPendingHash(hash);
      setApprovalRequest(null);
      setReturnedTeamWitness("");
      await checkConfirmation(hash);
    } catch (cause) {
      if (handleSessionChange(cause)) return;
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The Team-approved bootstrap could not be submitted." });
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
      await assertWalletSession(lucid, address);
      const tools = await import("@lucid-evolution/lucid");
      const tx = lucid.newTx()
        .collectFrom([offer.utxo], tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data))
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

  return <section className="dex-bootstrap">
    <div className="dex-bootstrap-head">
      <div><span className="section-kicker">Three-party liquidity launch</span><h2>FT provider, liquidity provider, and Team creator</h2></div>
      <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh offers"}</button>
    </div>
    <p className="dex-intro">The FT provider locks immutable pool terms on-chain. A different LP funds and signs the quote side, then the configured Team creator reviews that exact transaction and co-signs it before the pool and LP shares settle.</p>
    <ol className="dex-bootstrap-steps">
      <li><span>01</span><div><strong>FT provider locks an offer</strong><p>FT quantity, quote reserve, ADA buffer, and LP split are fixed in the datum.</p></div></li>
      <li><span>02</span><div><strong>LP funds and signs</strong><p>A different payment key funds tADA or USDCx and creates a partial witness.</p></div></li>
      <li><span>03</span><div><strong>Team creator approves</strong><p>The factory creator reviews the same CBOR, co-signs it, and the LP submits the complete settlement.</p></div></li>
    </ol>
    {pendingHash && <p className="dex-warning" role="status">Transaction submitted: <code>{pendingHash}</code>. Check confirmation before retrying. <button type="button" onClick={() => void checkConfirmation()} disabled={loading}>Check confirmation</button></p>}
    <fieldset className="module-fieldset" disabled={loading || Boolean(pendingHash)}>
    <form className="dex-bootstrap-form" onSubmit={submitOffer}>
      <div className="section-heading"><div><span className="section-kicker">New offer</span><h3>Lock the FT side</h3></div><span className="step-badge">{context ? "Ready" : loaded ? "Redeploy required" : "Loading"}</span></div>
      <div className="dex-form-grid">
        <label className="field field-wide"><span className="field-label">FT asset unit</span><input value={form.fractionUnit} onChange={(event) => update("fractionUnit", event.target.value)} placeholder="Policy ID + asset name in hex" required /></label>
        <label className="field"><span className="field-label">FT units to lock</span><input inputMode="numeric" pattern="[0-9]+" value={form.fractionAmount} onChange={(event) => update("fractionAmount", event.target.value)} required /></label>
        <label className="field"><span className="field-label">FT provider LP share (%)</span><input inputMode="decimal" value={form.ownerShare} onChange={(event) => update("ownerShare", event.target.value)} required /><span className="field-hint">The remaining share is minted to the liquidity provider.</span></label>
      </div>
      <fieldset className="dex-quote-choice"><legend>Quote side</legend><div className="segmented-control"><button type="button" className={form.quoteKind === "ada" ? "selected" : ""} onClick={() => update("quoteKind", "ada")}>tADA</button><button type="button" className={form.quoteKind === "usdcx" ? "selected" : ""} onClick={() => update("quoteKind", "usdcx")}>USDCx</button></div><div className="dex-form-grid">{form.quoteKind === "usdcx" && <label className="field field-wide"><span className="field-label">USDCx asset unit</span><input value={form.usdcxUnit} onChange={(event) => update("usdcxUnit", event.target.value)} placeholder="Policy ID + asset name in hex" required /></label>}<label className="field"><span className="field-label">{form.quoteKind === "ada" ? "Final tADA reserve" : "Final USDCx reserve"}</span><input inputMode="numeric" pattern="[0-9]+" value={form.quoteAmount} onChange={(event) => update("quoteAmount", event.target.value)} required /><span className="field-hint">{form.quoteKind === "ada" ? "Whole tADA; the LP funds the balance after the locked buffer." : "Smallest USDCx units; the LP funds the full quote reserve."}</span></label><label className="field"><span className="field-label">Pool ADA buffer</span><input inputMode="numeric" pattern="[0-9]+" value={form.poolAda} onChange={(event) => update("poolAda", event.target.value)} required /><span className="field-hint">At least 2 tADA, locked with the FT to keep the escrow and token/token pool valid.</span></label></div></fieldset>
      <div className="form-footer"><p><span className="status-dot" />{lucid ? " Eternl connected — review the on-chain terms before signing." : " Connect Eternl to lock the FT side."}</p>{!lucid ? <button type="button" className="primary-button" onClick={() => void connect()} disabled={loading}>Connect wallet</button> : <button type="submit" className="primary-button" disabled={loading || !context}>{loading ? "Awaiting wallet…" : "Create bootstrap offer"} <span className="button-arrow">↗</span></button>}</div>
    </form>
    {sessionError && <p className="form-message error-message" role="alert">{sessionError}</p>}
    {message && <p className={"form-message " + (message.kind === "error" ? "error-message" : "success-message")} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
    {approvalRequest && <section className="dex-bootstrap-handoff">
      <span className="section-kicker">Step 2 complete · send to Team</span><h3>LP signature ready</h3>
      <p>Keep this LP tab open. Send the exact transaction CBOR below to the configured Team creator. The Team must review the immutable transaction before signing; a changed or stale UTxO requires a new request.</p>
      <label><span>Approval transaction CBOR</span><textarea readOnly value={approvalRequest.transactionCbor} aria-label="Approval transaction CBOR" /></label>
      <label><span>Team approval witness</span><textarea value={returnedTeamWitness} onChange={(event) => setReturnedTeamWitness(event.target.value)} placeholder="Paste the witness returned by the Team creator" aria-label="Team approval witness" /></label>
      <div className="dex-bootstrap-handoff-actions"><button type="button" className="primary-button" onClick={() => void submitTeamApprovedBootstrap()} disabled={loading || !returnedTeamWitness.trim()}>Submit Team-approved pool <span className="button-arrow">↗</span></button><span>Offer: <code>{approvalRequest.offerId}</code></span></div>
    </section>}
    {context && <section className="dex-bootstrap-handoff">
      <span className="section-kicker">Step 3 · Team creator</span><h3>Review and co-sign an LP request</h3>
      <p>Connect only the wallet whose payment key hash is configured as the factory Team creator. Paste the LP&apos;s transaction CBOR, verify its inputs, outputs, pair, reserves, and LP split, then return only the generated witness to that LP.</p>
      <label><span>LP approval transaction CBOR</span><textarea value={teamTransaction} onChange={(event) => { setTeamTransaction(event.target.value); setTeamReview(null); setTeamAcknowledged(false); setTeamWitness(""); }} placeholder="Paste transaction CBOR from the liquidity provider" aria-label="LP approval transaction CBOR" /></label>
      <div className="dex-bootstrap-handoff-actions"><button type="button" onClick={() => void reviewTeamApproval()} disabled={loading || !teamTransaction.trim()}>Review bootstrap request</button><button type="button" onClick={() => void signTeamApproval()} disabled={loading || !teamReview?.result.ok || !teamAcknowledged}>Create Team approval witness</button></div>
      {teamReview && <div className={"dex-bootstrap-review " + (teamReview.result.ok ? "ready" : "error")}>{teamReview.result.ok ? <><strong>Verified bootstrap request</strong><p>Offer {teamReview.offer.id} creates pool {teamReview.result.poolName}. The FT provider receives {format(teamReview.result.ownerLp)} LP units; the liquidity provider receives {format(teamReview.result.providerLp)}.</p><dl><dt>FT reserve (base units)</dt><dd>{format(teamReview.offer.fractionAmount)} · <code>{assetUnit(teamReview.offer.fraction)}</code></dd><dt>Quote reserve (base units)</dt><dd>{format(teamReview.offer.quoteAmount)} · <code>{assetUnit(teamReview.offer.quote)}</code></dd><dt>Locked ADA buffer</dt><dd>{formatAda(teamReview.offer.poolLovelace)} tADA</dd><dt>FT provider</dt><dd><code>{teamReview.offer.owner}</code></dd><dt>Liquidity provider</dt><dd><code>{teamReview.provider.address}</code></dd><dt>Transaction hash / fee (lovelace)</dt><dd><code>{teamReview.hash}</code> / {teamReview.fee}</dd></dl><label><input type="checkbox" checked={teamAcknowledged} onChange={(event) => setTeamAcknowledged(event.target.checked)} /> I reviewed the offer, pair, reserves, LP split, and the absence of Team-wallet inputs or collateral.</label></> : <><strong>Do not sign this request</strong><ul>{teamReview.result.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></>}</div>}
      {teamWitness && <label><span>Return this Team witness to the liquidity provider</span><textarea readOnly value={teamWitness} aria-label="Generated Team approval witness" /></label>}
    </section>}
    <div className="dex-bootstrap-book">
      <div className="dex-pools-head"><div><span className="section-kicker">Open offers</span><h3>Awaiting an LP and Team approval</h3></div><span className="marketplace-count">{loaded ? offerSummary.length + " open" : "Loading"}</span></div>
      {!context && loaded && <p className="dex-warning">This DEX deployment predates three-party bootstrap offers. Run the reviewed Preprod redeploy before posting or accepting offers.</p>}
      {context && !lucid && <p className="dex-empty">Connect Eternl to inspect offers and take part.</p>}
      {context && lucid && loaded && offerSummary.length === 0 && <p className="dex-empty">No FT bootstrap offers are currently open.</p>}
      {offerSummary.map(({ offer, liquidity, ownerLp }) => <article className="dex-bootstrap-offer" key={offer.id}>
        <div><span className="marketplace-badge">FT provider escrow</span><strong>{displayAsset(offer.fraction)} · {format(offer.fractionAmount)} units</strong><code>{assetUnit(offer.fraction)}</code></div>
        <dl><div><dt>Quote reserve</dt><dd>{offer.quote.policyId ? format(offer.quoteAmount) : formatAda(offer.quoteAmount)} {displayAsset(offer.quote)}</dd></div><div><dt>Initial LP supply</dt><dd>{format(liquidity)}</dd></div><div><dt>FT provider / LP</dt><dd>{Number(offer.ownerShareBps) / 100}% / {100 - Number(offer.ownerShareBps) / 100}%</dd></div><div><dt>Team approval</dt><dd>Factory creator required</dd></div><div><dt>LP allocation</dt><dd>{format(ownerLp)} / {format(liquidity - ownerLp)}</dd></div></dl>
        <div className="dex-bootstrap-offer-actions">{offer.managed ? <button type="button" onClick={() => void cancel(offer)} disabled={loading}>Cancel offer</button> : !lucid ? <button type="button" onClick={() => void connect()} disabled={loading}>Connect to fund</button> : <button type="button" className="primary-button" onClick={() => void accept(offer)} disabled={loading}>Fund & request Team approval <span className="button-arrow">↗</span></button>}</div>
      </article>)}
    </div>
    </fieldset>
  </section>;
}
