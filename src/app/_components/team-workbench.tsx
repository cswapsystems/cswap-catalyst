"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { readRegistry } from "@/lib/asset-registry";
import { marketplaceDeployment } from "@/lib/protocol/marketplace-deployment";
import { formatAda } from "@/lib/ada";
import { useWallet } from "./wallet-context";

type Asset = { policyId: string; assetName: string };
type Request = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; raw: import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data>; seller: string; rwa: Asset; quantity: bigint; minimum: bigint; locked: bigint };
const unit = (asset: Asset) => asset.policyId ? asset.policyId + asset.assetName : "lovelace";

async function validator(title: string) {
  const response = await fetch("/api/marketplace-blueprint?validator=" + encodeURIComponent(title), { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || !body.compiledCode) throw new Error(body.error || "Marketplace validator unavailable.");
  return body.compiledCode as string;
}

export default function TeamWorkbench() {
  const { lucid, address } = useWallet();
  const [requests, setRequests] = useState<Request[]>([]);
  const [prices, setPrices] = useState<Record<string, { buy: string; sell: string }>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (!lucid) return setRequests([]);
    setBusy(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const addressData = (value: string) => {
        const details = tools.getAddressDetails(value); if (!details.paymentCredential) throw new Error("Invalid address.");
        const credential = (item: NonNullable<typeof details.paymentCredential>) => item.type === "Key" ? { PubKeyCredential: [item.hash] } : { ScriptCredential: [item.hash] };
        return tools.Data.from(tools.Data.to({ addressCredential: credential(details.paymentCredential), addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null } as never, tools.AddressSchema as never));
      };
      const script = { type: "PlutusV3" as const, script: tools.applyParamsToScript(await validator("pool_sell_request.pool_sell_request.spend"), [addressData(marketplaceDeployment.pool.address) as import("@lucid-evolution/lucid").Data]) };
      const requestAddress = tools.validatorToAddress("Preprod", script);
      const found: Request[] = [];
      for (const utxo of await lucid.utxosAt(requestAddress)) {
        if (!utxo.datum) continue;
        const raw = tools.Data.from(utxo.datum);
        if (!(raw instanceof tools.Constr) || raw.fields.length !== 7) continue;
        const rwa = raw.fields[3] as import("@lucid-evolution/lucid").Constr<unknown>;
        const sellerData = tools.Data.to(raw.fields[0] as import("@lucid-evolution/lucid").Data);
        const seller = tools.Data.to(addressData(address || "")) === sellerData ? address : (() => {
          const root = raw.fields[0] as import("@lucid-evolution/lucid").Constr<unknown>; const pay = root.fields[0] as import("@lucid-evolution/lucid").Constr<unknown>;
          const payment = { type: pay.index === 0 ? "Key" as const : "Script" as const, hash: pay.fields[0] as string };
          const stakeRoot = root.fields[1] as import("@lucid-evolution/lucid").Constr<unknown> | null;
          return stakeRoot ? tools.credentialToAddress("Preprod", payment, { type: (((stakeRoot.fields[0] as import("@lucid-evolution/lucid").Constr<unknown>).index === 0 ? "Key" : "Script") as "Key" | "Script"), hash: (stakeRoot.fields[0] as import("@lucid-evolution/lucid").Constr<unknown>).fields[0] as string }) : tools.credentialToAddress("Preprod", payment);
        })();
        found.push({ id: `${utxo.txHash}#${utxo.outputIndex}`, utxo, raw: raw as import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data>, seller: seller!, rwa: { policyId: rwa.fields[0] as string, assetName: rwa.fields[1] as string }, quantity: raw.fields[4] as bigint, minimum: raw.fields[6] as bigint, locked: utxo.assets.lovelace });
      }
      setRequests(found);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load requests."); }
    finally { setBusy(false); }
  }, [address, lucid]);

  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, [refresh]);

  async function settle(request: Request) {
    if (!lucid || !address) return setMessage("Connect the team wallet.");
    setBusy(true); setMessage("");
    try {
      const tools = await import("@lucid-evolution/lucid");
      const details = tools.getAddressDetails(address);
      if (details.paymentCredential?.type !== "Key" || details.paymentCredential.hash !== marketplaceDeployment.batcher) throw new Error("Only the configured team batcher wallet can set prices and settle requests.");
      const buy = BigInt(prices[request.id]?.buy || "0"), sell = BigInt(prices[request.id]?.sell || "0");
      if (buy < request.minimum || sell <= BigInt(0)) throw new Error("Buy price must meet the seller minimum and sell price must be positive.");
      const registry = await readRegistry(lucid); if (!registry.entries.includes(unit(request.rwa))) throw new Error("Register this exact asset unit before buying it into the shared pool.");
      const pool = await lucid.utxoByUnit(marketplaceDeployment.pool.token); if (!pool.datum) throw new Error("Shared pool state not found.");
      const poolDatum = tools.Data.from(pool.datum); if (!(poolDatum instanceof tools.Constr) || poolDatum.fields.length !== 10) throw new Error("Invalid pool datum.");
      const assetData = (asset: Asset) => new tools.Constr(0, [asset.policyId, asset.assetName]);
      const addressData = (value: string) => { const d = tools.getAddressDetails(value); if (!d.paymentCredential) throw new Error("Invalid address."); const c = (x: NonNullable<typeof d.paymentCredential>) => x.type === "Key" ? { PubKeyCredential: [x.hash] } : { ScriptCredential: [x.hash] }; return tools.Data.from(tools.Data.to({ addressCredential: c(d.paymentCredential), addressStakingCredential: d.stakeCredential ? { StakingHash: [c(d.stakeCredential)] } : null } as never, tools.AddressSchema as never)); };
      const poolToken: Asset = { policyId: marketplaceDeployment.pool.token.slice(0, 56), assetName: marketplaceDeployment.pool.token.slice(56) };
      const inventory: Asset = { policyId: marketplaceDeployment.pool.inventoryToken.slice(0, 56), assetName: marketplaceDeployment.pool.inventoryToken.slice(56) };
      const listing = new tools.Constr(0, [addressData(marketplaceDeployment.pool.address), marketplaceDeployment.batcher, new tools.Constr(1, [assetData(poolToken), assetData(inventory)]), assetData(request.rwa), request.quantity, assetData({ policyId: "", assetName: "" }), sell]);
      const next = new tools.Constr(0, [...poolDatum.fields.slice(0, 9), (poolDatum.fields[9] as bigint) + sell]);
      const requestScript = { type: "PlutusV3" as const, script: tools.applyParamsToScript(await validator("pool_sell_request.pool_sell_request.spend"), [addressData(marketplaceDeployment.pool.address) as import("@lucid-evolution/lucid").Data]) };
      const poolScript = { type: "PlutusV3" as const, script: tools.applyParamsToScript(await validator("quote_pool.quote_pool.spend"), [addressData(marketplaceDeployment.orderbookAddress) as import("@lucid-evolution/lucid").Data]) };
      const inventoryPolicy = { type: "PlutusV3" as const, script: tools.applyParamsToScript(await validator("inventory_policy.inventory_policy.mint"), [assetData(poolToken), inventory.assetName, marketplaceDeployment.batcher]) };
      const nextAssets = { ...pool.assets, lovelace: pool.assets.lovelace - buy - request.locked };
      if (nextAssets.lovelace < BigInt(marketplaceDeployment.pool.minCashReserve)) throw new Error("Pool would fall below its minimum reserve.");
      const poolRedeemer = new tools.Constr(3, [buy, request.raw, listing, next]);
      const tx = lucid.newTx().collectFrom([request.utxo], tools.Data.to(new tools.Constr(0, []))).collectFrom([pool], tools.Data.to(poolRedeemer)).mintAssets({ [unit(inventory)]: BigInt(1) }, tools.Data.to(new tools.Constr(0, []))).attach.SpendingValidator(requestScript).attach.SpendingValidator(poolScript).attach.MintingPolicy(inventoryPolicy).pay.ToContract(marketplaceDeployment.pool.address, { kind: "inline", value: tools.Data.to(next) }, nextAssets).pay.ToContract(marketplaceDeployment.orderbookAddress, { kind: "inline", value: tools.Data.to(listing) }, { lovelace: request.locked, [unit(request.rwa)]: request.quantity, [unit(inventory)]: BigInt(1) }).pay.ToAddress(request.seller, { lovelace: buy + request.locked }).addSigner(address);
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit(); setMessage("Settled with team bid/ask: " + hash); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Settlement failed."); }
    finally { setBusy(false); }
  }

  return <div className="team-workbench"><section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">Team operations</span><h2>Shared pool control</h2></div><span className="step-badge">Preprod live</span></div><p className="mint-intro">The team wallet controls the supported exact asset units and sets both the acquisition price and resale price. Private keys never enter this app.</p><div className="marketplace-toolbar"><Link href="/registry">Manage supported assets</Link><Link href="/reserves">Manage pool liquidity</Link></div>{requests.map((request) => <article className="marketplace-listing" key={request.id}><div className="marketplace-asset"><div><strong>{request.quantity.toString()} units</strong><code>{unit(request.rwa)}</code><span>Seller minimum: {formatAda(request.minimum)} ADA</span></div></div><label className="field"><span>Team buy price (lovelace)</span><input inputMode="numeric" value={prices[request.id]?.buy || ""} onChange={(e) => setPrices((p) => ({ ...p, [request.id]: { buy: e.target.value, sell: p[request.id]?.sell || "" } }))} /></label><label className="field"><span>Team sell price (lovelace)</span><input inputMode="numeric" value={prices[request.id]?.sell || ""} onChange={(e) => setPrices((p) => ({ ...p, [request.id]: { buy: p[request.id]?.buy || "", sell: e.target.value } }))} /></label><button className="primary-button" disabled={busy} onClick={() => void settle(request)}>Set prices &amp; acquire</button></article>)}{!requests.length && <p className="marketplace-empty">No pending instant-sell requests.</p>}{message && <p role="status">{message}</p>}</section></div>;
}
