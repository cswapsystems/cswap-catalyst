"use client";

import { confirmTransaction } from "@/lib/transaction-confirmation";

import Link from "next/link";
import { decodeCardanoAddress } from "@/lib/address-codec";
import { useCallback, useEffect, useState } from "react";
import { readRegistry } from "@/lib/asset-registry";
import { marketplaceDeployment } from "@/lib/protocol/marketplace-deployment";
import { formatAda } from "@/lib/ada";
import { useWallet } from "./wallet-context";
import { fetchPriceBook, instantSellQuote, type PriceBook } from "@/lib/price-book";
import { readInventory } from "@/lib/protocol/inventory";
import { asAsset, assetUnit } from "@/lib/protocol/dex-client";
import { readSharedPool } from "@/lib/protocol/shared-pool-client";

type Asset = { policyId: string; assetName: string };
type Request = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; raw: import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data>; seller: string; rwa: Asset; quantity: bigint; minimum: bigint; locked: bigint };
const unit = (asset: Asset) => asset.policyId ? asset.policyId + asset.assetName : "lovelace";

async function validator(title: string) {
  const response = await fetch("/api/marketplace-blueprint?validator=" + encodeURIComponent(title), { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || !body.compiledCode) throw new Error(body.error || "Marketplace validator unavailable.");
  return body.compiledCode as string;
}

export default function TeamWorkbench({ onSettled }: { onSettled?: () => Promise<void> }) {
  const { lucid, address } = useWallet();
  const [requests, setRequests] = useState<Request[]>([]);
  const [book, setBook] = useState<PriceBook | null>(null);
  const [held, setHeld] = useState<Record<string, bigint>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [capacity, setCapacity] = useState<{ cash: bigint; minimum: bigint; inventory: bigint; paused: boolean } | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<Record<string, string> | null>(null);
  const [pendingHash, setPendingHash] = useState("");

  const refresh = useCallback(async () => {
    if (!lucid) return setRequests([]);
    setBusy(true); setMessage(""); setRequests([]); setBook(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const [livePool, prices, inventory] = await Promise.all([readSharedPool(lucid, tools), fetchPriceBook(), readInventory(lucid, tools)]);
      setBook(prices.book); setHeld(inventory.holdings);
      if (livePool.quote.policyId) throw new Error("This pricing queue supports the configured ADA settlement pool only.");
      setCapacity({ cash: livePool.cash, minimum: livePool.minimum, inventory: livePool.inventory, paused: livePool.paused });
      const connectedKey = tools.getAddressDetails(address || "").paymentCredential;
      setAuthorized(connectedKey?.type === "Key" && connectedKey.hash === livePool.batcher && livePool.batcher === marketplaceDeployment.batcher);
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
        try {
        const raw = tools.Data.from(utxo.datum);
        if (!(raw instanceof tools.Constr) || raw.index !== 0 || raw.fields.length !== 7 || typeof raw.fields[4] !== "bigint" || raw.fields[4] <= BigInt(0) || typeof raw.fields[6] !== "bigint" || assetUnit(asAsset(raw.fields[2], "request pool")) !== marketplaceDeployment.pool.token || assetUnit(asAsset(raw.fields[5], "quote")) !== "lovelace") continue;
        const rwa = raw.fields[3] as import("@lucid-evolution/lucid").Constr<unknown>;
        let seller: string;
        try { seller = decodeCardanoAddress(raw.fields[0], tools); } catch { continue; }
        found.push({ id: `${utxo.txHash}#${utxo.outputIndex}`, utxo, raw: raw as import("@lucid-evolution/lucid").Constr<import("@lucid-evolution/lucid").Data>, seller: seller!, rwa: { policyId: rwa.fields[0] as string, assetName: rwa.fields[1] as string }, quantity: raw.fields[4] as bigint, minimum: raw.fields[6] as bigint, locked: utxo.assets.lovelace });
        } catch { /* Malformed unrelated outputs must not hide valid requests. */ }
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
      if (pendingHash) throw new Error("Check the pending settlement before submitting another acquisition.");
      if (await lucid.wallet().address() !== address) throw new Error("Wallet changed. Reconnect before signing.");
      if (details.paymentCredential?.type !== "Key" || details.paymentCredential.hash !== marketplaceDeployment.batcher) throw new Error("Only the configured team batcher wallet can set prices and settle requests.");
      const snapshot = await readSharedPool(lucid, tools);
      const [latest, inventoryState] = await Promise.all([fetchPriceBook(), readInventory(lucid, tools)]);
      if (!book || latest.book.revision !== book.revision) throw new Error("Operator prices changed. Refresh the queue and review before signing.");
      const { bid: buy, ask: sell } = instantSellQuote(latest.book, unit(request.rwa), request.quantity, inventoryState.holdings[unit(request.rwa)] || BigInt(0));
      const liveRequest = (await lucid.utxosByOutRef([{ txHash: request.utxo.txHash, outputIndex: request.utxo.outputIndex }]))[0];
      if (!liveRequest || liveRequest.datum !== request.utxo.datum) throw new Error("Request is no longer available. Refresh the queue.");
      if (!references[request.id]?.trim()) throw new Error("Record a valuation source and approval reference before signing.");
      if (buy < request.minimum || sell <= BigInt(0)) throw new Error("Buy price must meet the seller minimum and sell price must be positive.");
      const registry = await readRegistry(lucid); if (!registry.entries.includes(unit(request.rwa))) throw new Error("Register this exact asset unit before buying it into the shared pool.");
      const livePool = await readSharedPool(lucid, tools);
      if (snapshot.utxo.txHash !== livePool.utxo.txHash || snapshot.utxo.outputIndex !== livePool.utxo.outputIndex) throw new Error("Pool inventory changed while preparing the quote. Refresh before signing.");
      const pool = livePool.utxo; if (!pool.datum) throw new Error("Shared pool state not found.");
      const poolDatum = tools.Data.from(pool.datum); if (!(poolDatum instanceof tools.Constr) || poolDatum.fields.length !== 10) throw new Error("Invalid pool datum.");
      const pauseFlag = poolDatum.fields[8];
      if (!(pauseFlag instanceof tools.Constr) || pauseFlag.index !== 0) throw new Error("Pool is paused or its status cannot be verified.");
      if (poolDatum.fields[1] !== marketplaceDeployment.batcher) throw new Error("The live batcher differs from the reviewed deployment.");
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
      if (typeof poolDatum.fields[7] !== "bigint" || nextAssets.lovelace < poolDatum.fields[7]) throw new Error("Pool would fall below its current minimum reserve.");
      const poolRedeemer = new tools.Constr(3, [buy, request.raw, listing, next]);
      const tx = lucid.newTx().collectFrom([request.utxo], tools.Data.to(new tools.Constr(0, []))).collectFrom([pool], tools.Data.to(poolRedeemer)).mintAssets({ [unit(inventory)]: BigInt(1) }, tools.Data.to(new tools.Constr(0, []))).attach.SpendingValidator(requestScript).attach.SpendingValidator(poolScript).attach.MintingPolicy(inventoryPolicy).pay.ToContract(marketplaceDeployment.pool.address, { kind: "inline", value: tools.Data.to(next) }, nextAssets).pay.ToContract(marketplaceDeployment.orderbookAddress, { kind: "inline", value: tools.Data.to(listing) }, { lovelace: request.locked, [unit(request.rwa)]: request.quantity, [unit(inventory)]: BigInt(1) }).pay.ToAddress(request.seller, { lovelace: buy + request.locked }).addSigner(address);
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
      setPendingHash(hash); setReceipt({ transaction: hash, request: request.id, poolInput: `${pool.txHash}#${pool.outputIndex}`, signer: address, asset: unit(request.rwa), bidLovelace: buy.toString(), askLovelace: sell.toString(), priceBookRevision: String(latest.book.revision), sourceAndApproval: references[request.id], expectedCashLovelace: nextAssets.lovelace.toString(), submittedAt: new Date().toISOString() });
      setMessage("Settlement submitted. Awaiting confirmation.");
      if (!await confirmTransaction(lucid, hash)) throw new Error("Confirmation is not yet available. Check the submitted transaction before retrying.");
      setPendingHash(""); setMessage("Settlement confirmed: " + hash); await refresh(); await onSettled?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Settlement failed."); }
    finally { setBusy(false); }
  }

  function downloadReceipt() {
    if (!receipt) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "settlement-" + receipt.transaction + ".json"; link.click(); URL.revokeObjectURL(url);
  }

  async function checkConfirmation() {
    if (!pendingHash) return;
    setBusy(true);
    try {
      const response = await fetch("/api/blockfrost/txs/" + pendingHash, { cache: "no-store" });
      if (!response.ok) throw new Error("Confirmation is not yet available.");
      setPendingHash(""); setMessage("Settlement confirmed."); await refresh(); await onSettled?.();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Unable to check confirmation."); }
    finally { setBusy(false); }
  }

  return <div className="team-workbench"><section className="work-card form-card">
    <div className="section-heading"><h2>Approve incoming requests</h2><button type="button" className="refresh-button" disabled={busy} onClick={() => void refresh()}>Refresh queue</button></div>
    <div className="marketplace-toolbar"><Link href="/team/inventory">Manage prices & limits</Link><Link href="/registry">Manage supported assets</Link><Link href="/team/controls">Pool controls</Link></div>
    {!lucid ? <p>Connect the batcher wallet to inspect and settle requests.</p> : <>
    {!authorized && <p className="registry-action-blocked">Only the configured batcher can settle requests.</p>}
    {requests.map((request) => {
      let after: bigint | null = null;
      let quote: ReturnType<typeof instantSellQuote> | null = null;
      let blocked = "";
      try { if (!book) throw new Error("Operator prices are unavailable."); quote = instantSellQuote(book, unit(request.rwa), request.quantity, held[unit(request.rwa)] || BigInt(0)); if (quote.bid < request.minimum) throw new Error("Current bid is below the seller minimum."); if (capacity) after = capacity.cash - quote.bid - request.locked; } catch (error) { blocked = error instanceof Error ? error.message : "Quote unavailable."; }
      return <article className="operator-request" key={request.id}>
        <div><strong>{request.quantity.toString()} units</strong><code>{unit(request.rwa)}</code><p>Seller minimum: {formatAda(request.minimum)} ADA</p></div>
        <fieldset className="module-fieldset" disabled={busy || !authorized || Boolean(pendingHash)}>
          <div className="execution-preview">{quote && <p>Total bid: {formatAda(quote.bid)} ADA · Total resale ask: {formatAda(quote.ask)} ADA · Price book v{book?.revision}</p>}{blocked && <p role="status">{blocked}</p>}</div>
          <label className="field"><span>Acquisition approval reference</span><input value={references[request.id] || ""} onChange={(event) => setReferences((previous) => ({ ...previous, [request.id]: event.target.value }))} placeholder="Approval ticket / operator note" /></label>
          {capacity && <div className="execution-preview"><p>Protected reserve: {formatAda(capacity.minimum)} ADA</p><p>Cash after acquisition: {after === null ? "Unavailable" : formatAda(after) + " ADA"}</p><p>Includes {formatAda(request.locked)} ADA funded for the inventory listing.</p>{after !== null && after < capacity.minimum && <p role="alert">Bid exceeds available settlement cash.</p>}{capacity.paused && <p role="alert">Pool paused.</p>}</div>}
          <button className="primary-button" type="button" disabled={Boolean(blocked) || !quote || !capacity || capacity.paused || after === null || after < capacity.minimum || !references[request.id]?.trim()} onClick={() => void settle(request)}>Sign acquisition</button>
        </fieldset>
      </article>;
    })}
    {!requests.length && !busy && <p className="marketplace-empty">No pending requests loaded.</p>}
    </>}
    {message && <p role="status">{message}</p>}
    {pendingHash && <p><a href={"https://preprod.cardanoscan.io/transaction/" + pendingHash} target="_blank" rel="noreferrer">Inspect pending transaction</a> <button type="button" disabled={busy} onClick={() => void checkConfirmation()}>Check confirmation</button></p>}
    {receipt && <div className="execution-preview"><p>Download this submission record for reconciliation. Confirm the transaction on-chain before treating it as settled. This record is held only in this page session.</p><button type="button" className="refresh-button" onClick={downloadReceipt}>Download settlement record</button></div>}
  </section></div>;
}
