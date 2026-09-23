"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useWallet } from "./wallet-context";
import { marketplaceOrderbookAddress, marketplacePoolAddress } from "@/lib/protocol/marketplace-deployment";
import { formatAda } from "@/lib/ada";
import { decodeCardanoAddress } from "@/lib/address-codec";


type ListingLayout = "card" | "list";
type AssetClass = { policyId: string; assetName: string };
type Constr = { index: number; fields: unknown[] };
type FractionInfo = { fraction: AssetClass; original: AssetClass; totalFractions: bigint };
type Listing = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; seller: string; sellerKey: string; managed: boolean; settlement: "direct" | "pool"; poolToken?: AssetClass; inventoryToken?: AssetClass; fraction?: FractionInfo; rwa: AssetClass; quantity: bigint; priceAsset: AssetClass; price: bigint; lockedLovelace: bigint };
type PoolSellRequest = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; seller: string; sellerKey: string; managed: boolean; poolToken: AssetClass; rwa: AssetClass; quantity: bigint; quoteAsset: AssetClass; minPayout: bigint; lockedLovelace: bigint };


function isConstr(value: unknown): value is Constr {
  return typeof value === "object" && value !== null && "index" in value && "fields" in value &&
    typeof (value as { index: unknown }).index === "number" &&
    Array.isArray((value as { fields: unknown }).fields);
}
function getConstr(value: unknown, label: string): Constr {
  if (!isConstr(value)) throw new Error("Malformed " + label + " datum.");
  return value;
}
function getAsset(value: unknown, label: string): AssetClass {
  const c = getConstr(value, label);
  if (c.index !== 0 || c.fields.length !== 2 || typeof c.fields[0] !== "string" || typeof c.fields[1] !== "string") throw new Error("Malformed " + label + " asset.");
  return { policyId: c.fields[0], assetName: c.fields[1] };
}
function getAddress(value: unknown, tools: { credentialToAddress: (network: import("@lucid-evolution/lucid").Network, payment: { type: "Key" | "Script"; hash: string }, stake?: { type: "Key" | "Script"; hash: string }) => string }): string {
  return decodeCardanoAddress(value, tools, process.env.NEXT_PUBLIC_CARDANO_NETWORK === "mainnet" ? "Mainnet" : "Preprod");
}
function decodeListing(utxo: import("@lucid-evolution/lucid").UTxO, tools: { Data: { from: (raw: string) => unknown }; credentialToAddress: (network: import("@lucid-evolution/lucid").Network, payment: { type: "Key" | "Script"; hash: string }, stake?: { type: "Key" | "Script"; hash: string }) => string }): Listing {
  if (!utxo.datum) throw new Error("Listing has no datum.");
  const root = getConstr(tools.Data.from(utxo.datum), "listing");
  if (root.index !== 0 || root.fields.length !== 7) throw new Error("Not a simple listing datum.");
  const settlement = getConstr(root.fields[2], "settlement");
  return {
    id: utxo.txHash + "#" + utxo.outputIndex,
    utxo,
    seller: getAddress(root.fields[0], tools),
    sellerKey: root.fields[1] as string,
    managed: false,
    settlement: settlement.index === 1 ? "pool" : "direct",
    poolToken: settlement.index === 1 ? getAsset(settlement.fields[0], "pool") : undefined,
    inventoryToken: settlement.index === 1 ? getAsset(settlement.fields[1], "inventory receipt") : undefined,
    rwa: getAsset(root.fields[3], "listed"),
    quantity: root.fields[4] as bigint,
    priceAsset: getAsset(root.fields[5], "price"),
    price: root.fields[6] as bigint,
    lockedLovelace: utxo.assets.lovelace,
  };
}
function assetData(ConstrClass: typeof import("@lucid-evolution/lucid").Constr, asset: AssetClass): Constr {
  return new ConstrClass(0, [asset.policyId, asset.assetName]) as Constr;
}
function addressData(Data: typeof import("@lucid-evolution/lucid").Data, AddressSchema: typeof import("@lucid-evolution/lucid").AddressSchema, getAddressDetails: typeof import("@lucid-evolution/lucid").getAddressDetails, address: string): unknown {
  const details = getAddressDetails(address);
  if (!details || !details.paymentCredential) throw new Error("The proceeds address is not a supported Cardano address.");
  const payment = details.paymentCredential.type === "Key" ? { PubKeyCredential: [details.paymentCredential.hash] } : { ScriptCredential: [details.paymentCredential.hash] };
  const staking = details.stakeCredential ? { StakingHash: [details.stakeCredential.type === "Key" ? { PubKeyCredential: [details.stakeCredential.hash] } : { ScriptCredential: [details.stakeCredential.hash] }] } : null;
  return Data.from(Data.to({ addressCredential: payment, addressStakingCredential: staking } as never, AddressSchema as never));
}
function unit(asset: AssetClass): string { return asset.policyId + asset.assetName; }
function sameAsset(a: AssetClass, b: AssetClass): boolean { return a.policyId === b.policyId && a.assetName === b.assetName; }
function assetNameText(assetName: string): string {
  if (!assetName) return "Unnamed asset";
  try {
    const bytes = Uint8Array.from(assetName.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text || "Unnamed asset";
  } catch {
    return "Binary asset";
  }
}
function metadataText(value: unknown): string {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string").join("") : typeof value === "string" ? value : "";
}
function ipfsGatewayUrl(value: unknown): string | null {
  const uri = metadataText(value);
  const cid = uri.startsWith("ipfs://") ? uri.slice(7).split("/")[0] : "";
  return /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(cid) ? "/api/ipfs/gateway/" + cid : null;
}
async function loadFractionIndex(lucid: import("@lucid-evolution/lucid").LucidEvolution): Promise<Map<string, FractionInfo>> {
  const response = await fetch("/api/fractionalize-blueprint", { cache: "no-store" });
  const blueprint = await response.json() as { vaultCompiledCode?: string; error?: string };
  if (!response.ok || !blueprint.vaultCompiledCode) throw new Error(blueprint.error ?? "Fractionalization validator unavailable.");
  const tools = await import("@lucid-evolution/lucid");
  const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "mainnet" ? "Mainnet" as const : "Preprod" as const;
  const vaultAddress = tools.validatorToAddress(network, { type: "PlutusV3", script: blueprint.vaultCompiledCode });
  const index = new Map<string, FractionInfo>();
  for (const utxo of await lucid.utxosAt(vaultAddress)) {
    if (!utxo.datum) continue;
    try {
      const root = getConstr(tools.Data.from(utxo.datum), "vault");
      if (root.index !== 0 || root.fields.length !== 8 || typeof root.fields[2] !== "string" || typeof root.fields[3] !== "string" || typeof root.fields[4] !== "string" || typeof root.fields[5] !== "string" || typeof root.fields[6] !== "bigint") continue;
      const original = { policyId: root.fields[2], assetName: root.fields[3] };
      const fraction = { policyId: root.fields[4], assetName: root.fields[5] };
      index.set(unit(fraction), { fraction, original, totalFractions: root.fields[6] });
    } catch {
      // Ignore unrelated or legacy vault outputs.
    }
  }
  return index;
}
function withAsset(assets: import("@lucid-evolution/lucid").Assets, asset: AssetClass, amount: bigint): import("@lucid-evolution/lucid").Assets {
  const key = asset.policyId ? unit(asset) : "lovelace";
  return { ...assets, [key]: (assets[key] ?? BigInt(0)) + amount };
}
async function loadScript(title: string): Promise<import("@lucid-evolution/lucid").Script> {
  const response = await fetch("/api/marketplace-blueprint?validator=" + encodeURIComponent(title), { cache: "no-store" });
  const body = await response.json() as { compiledCode?: string; error?: string };
  if (!response.ok || !body.compiledCode) throw new Error(body.error ?? "Marketplace validator unavailable.");
  return { type: "PlutusV3", script: body.compiledCode };
}
async function loadListingScript(address: string, tools: typeof import("@lucid-evolution/lucid")): Promise<import("@lucid-evolution/lucid").Script> {
  const details = tools.getAddressDetails(address);
  const scriptHash = details?.paymentCredential?.type === "Script" ? details.paymentCredential.hash : "";
  const response = await fetch("/api/marketplace-blueprint?validator=p2p_listing_simple.p2p_listing_simple.spend&scriptHash=" + encodeURIComponent(scriptHash), { cache: "no-store" });
  const body = await response.json() as { compiledCode?: string; error?: string };
  if (!response.ok || !body.compiledCode) throw new Error(body.error ?? "Marketplace listing validator unavailable.");
  const script = { type: "PlutusV3" as const, script: body.compiledCode };
  if (scriptHash && tools.validatorToScriptHash(script) !== scriptHash) throw new Error("Marketplace listing validator does not match the listing address.");
  return script;
}
function decodePoolSellRequest(utxo: import("@lucid-evolution/lucid").UTxO, tools: { Data: { from: (raw: string) => unknown }; credentialToAddress: (network: import("@lucid-evolution/lucid").Network, payment: { type: "Key" | "Script"; hash: string }, stake?: { type: "Key" | "Script"; hash: string }) => string }): PoolSellRequest {
  if (!utxo.datum) throw new Error("Pool sell request has no datum.");
  const root = getConstr(tools.Data.from(utxo.datum), "pool sell request");
  if (root.index !== 0 || root.fields.length !== 7 || typeof root.fields[1] !== "string" || typeof root.fields[4] !== "bigint" || typeof root.fields[6] !== "bigint") throw new Error("Not a pool sell request datum.");
  return { id: utxo.txHash + "#" + utxo.outputIndex, utxo, seller: getAddress(root.fields[0], tools), sellerKey: root.fields[1], managed: false, poolToken: getAsset(root.fields[2], "request pool token"), rwa: getAsset(root.fields[3], "requested RWA"), quantity: root.fields[4], quoteAsset: getAsset(root.fields[5], "request quote asset"), minPayout: root.fields[6], lockedLovelace: utxo.assets.lovelace };
}
export default function MarketplaceWorkbench({ ownerOnly = false }: { ownerOnly?: boolean }) {
  const { address, lucid, connect } = useWallet();
  const [listingLayout, setListingLayout] = useState<ListingLayout>("card");
  const [listings, setListings] = useState<Listing[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [purchasedListingIds, setPurchasedListingIds] = useState<Set<string>>(() => new Set());
  const [sellRequests, setSellRequests] = useState<PoolSellRequest[]>([]);
  const [editing, setEditing] = useState<Listing | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [marketplaceToast, setMarketplaceToast] = useState<string | null>(null);
  const orderbookAddress = marketplaceOrderbookAddress;
  const quotePoolAddress = marketplacePoolAddress;

  useEffect(() => {
    if (!marketplaceToast) return;
    const timer = window.setTimeout(() => setMarketplaceToast(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [marketplaceToast]);


  const refresh = useCallback(async () => {
    setMessage(null);
    if (!lucid || !orderbookAddress) { setListings([]); setLoaded(true); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      let fractions = new Map<string, FractionInfo>();
      try { fractions = await loadFractionIndex(lucid); } catch { /* Fraction metadata is optional for generic listings. */ }
      const found: Listing[] = [];
      const orderbookUtxos = await lucid.utxosAt(orderbookAddress);
      for (const utxo of orderbookUtxos) {
        if (!utxo.datum) continue;
        try {
          const listing = decodeListing(utxo, tools);
          const details = address ? tools.getAddressDetails(address) : undefined;
          const managed = details?.paymentCredential?.type === "Key" && details.paymentCredential.hash === listing.sellerKey;
          found.push({ ...listing, managed, fraction: fractions.get(unit(listing.rwa)) });
        } catch { /* skip unrelated script UTxOs */ }
      }
      const requests: PoolSellRequest[] = [];
      if (quotePoolAddress) {
        try {
          const requestCode = await loadScript("pool_sell_request.pool_sell_request.spend");
          const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "mainnet" ? "Mainnet" as const : "Preprod" as const;
          const requestAddress = tools.validatorToAddress(network, { type: "PlutusV3", script: tools.applyParamsToScript(requestCode.script, [addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, quotePoolAddress) as import("@lucid-evolution/lucid").Data]) });
          for (const utxo of await lucid.utxosAt(requestAddress)) {
            if (!utxo.datum) continue;
            try {
              const request = decodePoolSellRequest(utxo, tools);
              const details = address ? tools.getAddressDetails(address) : undefined;
              requests.push({ ...request, managed: details?.paymentCredential?.type === "Key" && details.paymentCredential.hash === request.sellerKey });
            } catch { /* Skip unrelated script outputs. */ }
          }
        } catch { /* Request availability does not prevent orderbook browsing. */ }
      }
      setListings(ownerOnly ? found.filter((listing) => listing.managed && listing.settlement === "direct") : found); setSellRequests(ownerOnly ? requests.filter((request) => request.managed) : requests); setLoaded(true);
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to read orderbook listings." });
    } finally { setLoading(false); }
  }, [address, lucid, orderbookAddress, quotePoolAddress, ownerOnly]);

  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    const units = [...new Set(listings.map((listing) => unit(listing.rwa)))];
    if (units.length === 0) { setThumbnails({}); return; }
    void Promise.all(units.map(async (assetUnit) => {
      try {
        const response = await fetch("/api/blockfrost/assets/" + encodeURIComponent(assetUnit), { cache: "force-cache" });
        const asset = await response.json() as { onchain_metadata?: { image?: unknown } };
        const thumbnail = ipfsGatewayUrl(asset.onchain_metadata?.image);
        return thumbnail ? [assetUnit, thumbnail] as const : null;
      } catch { return null; }
    })).then((results) => {
      if (!cancelled) setThumbnails(Object.fromEntries(results.filter((result): result is readonly [string, string] => result !== null)));
    });
    return () => { cancelled = true; };
  }, [listings]);
  const p2pListings = useMemo(() => listings.filter((listing) => listing.settlement === "direct"), [listings]);
  const poolListings = useMemo(() => listings.filter((listing) => listing.settlement === "pool"), [listings]);

  async function buyListing(listing: Listing) {
    setMessage(null);
    if (!lucid || !address) { setMessage({ kind: "error", text: "Connect Eternl before buying." }); return; }
    if (listing.managed) { setMessage({ kind: "error", text: "You cannot buy a listing created by this wallet." }); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const buyer = addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, address);
      let tx = lucid.newTx().collectFrom([listing.utxo], tools.Data.to(new tools.Constr(0, [buyer]) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(await loadListingScript(listing.utxo.address, tools));
      if (listing.settlement === "direct") {
        if (listing.priceAsset.policyId) {
          tx = tx.pay.ToAddress(listing.seller, { [unit(listing.priceAsset)]: listing.price }).pay.ToAddress(listing.seller, { lovelace: listing.lockedLovelace });
        } else {
          tx = tx.pay.ToAddress(listing.seller, { lovelace: listing.price + listing.lockedLovelace });
        }
        tx = tx.pay.ToAddress(address, { lovelace: BigInt(2000000), [unit(listing.rwa)]: listing.quantity });
      } else {
        if (!listing.poolToken) throw new Error("Pool inventory is missing its pool identity.");
        const poolUtxo = await lucid.utxoByUnit(unit(listing.poolToken));
        if (!poolUtxo.datum) throw new Error("The quote pool has no inline datum.");
        const poolRoot = getConstr(tools.Data.from(poolUtxo.datum), "quote pool");
        if (poolRoot.fields.length !== 10 || typeof poolRoot.fields[9] !== "bigint") throw new Error("Malformed quote pool datum.");
        const quoteAsset = getAsset(poolRoot.fields[5], "pool quote");
        const inventoryToken = getAsset(poolRoot.fields[4], "inventory receipt");
        if (!listing.inventoryToken || !sameAsset(listing.inventoryToken, inventoryToken)) throw new Error("Pool inventory receipt does not match the pool.");
        if (!sameAsset(quoteAsset, listing.priceAsset)) throw new Error("Pool quote asset does not match listing.");
        let nextAssets = withAsset({ ...poolUtxo.assets }, quoteAsset, listing.price);
        if (quoteAsset.policyId) nextAssets = withAsset(nextAssets, { policyId: "", assetName: "" }, listing.lockedLovelace);
        const nextInventoryValue = poolRoot.fields[9] as bigint - listing.price;
        if (nextInventoryValue < BigInt(0)) throw new Error("Pool inventory accounting is below this listing price.");
        const nextDatum = new tools.Constr(0, [
          poolRoot.fields[0],
          poolRoot.fields[1],
          poolRoot.fields[2],
          poolRoot.fields[3],
          poolRoot.fields[4],
          poolRoot.fields[5],
          poolRoot.fields[6],
          poolRoot.fields[7],
          poolRoot.fields[8],
          nextInventoryValue,
        ]);
        // QuotePoolRedeemer.InventorySale follows BatcherInstantSell in the
        // on-chain enum, so its constructor index is 4.
        const poolRedeemer = new tools.Constr(4, [listing.price, buyer, nextDatum]);
        const poolCode = await loadScript("quote_pool.quote_pool.spend");
        const receiptCode = await loadScript("inventory_policy.inventory_policy.mint");
        const poolScript = { type: "PlutusV3" as const, script: tools.applyParamsToScript(poolCode.script, [addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, orderbookAddress) as import("@lucid-evolution/lucid").Data]) };
        const receiptPolicy = { type: "PlutusV3" as const, script: tools.applyParamsToScript(receiptCode.script, [assetData(tools.Constr, listing.poolToken) as import("@lucid-evolution/lucid").Data, inventoryToken.assetName as import("@lucid-evolution/lucid").Data, poolRoot.fields[1] as import("@lucid-evolution/lucid").Data]) };
        if (tools.mintingPolicyToId(receiptPolicy) !== inventoryToken.policyId) throw new Error("Pool inventory receipt policy does not match the pool datum.");
        tx = tx.collectFrom([poolUtxo], tools.Data.to(poolRedeemer as import("@lucid-evolution/lucid").Data)).mintAssets({ [unit(inventoryToken)]: -BigInt(1) }, tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(poolScript).attach.MintingPolicy(receiptPolicy).pay.ToContract(poolUtxo.address, { kind: "inline", value: tools.Data.to(nextDatum as import("@lucid-evolution/lucid").Data) }, nextAssets);
      }
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
      setPurchasedListingIds((current) => new Set(current).add(listing.id));
      setMessage({ kind: "success", text: "Buy submitted: " + hash }); await refresh();
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Purchase was cancelled or failed." }); }
    finally { setLoading(false); }
  }

  async function cancelListing(listing: Listing) {
    setMessage(null);
    if (!lucid || !address || !listing.managed) { setMessage({ kind: "error", text: "Connect the listing management wallet before cancelling." }); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const tx = await lucid.newTx().collectFrom([listing.utxo], tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(await loadListingScript(listing.utxo.address, tools)).pay.ToAddress(listing.seller, { ...listing.utxo.assets }).addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      setMessage({ kind: "success", text: "Cancellation submitted: " + hash }); setMarketplaceToast("Listing cancellation submitted: " + hash); await refresh();
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Cancellation was cancelled or failed." }); }
    finally { setLoading(false); }
  }

  async function cancelPoolSellRequest(request: PoolSellRequest) {
    setMessage(null);
    if (!lucid || !address || !request.managed) { setMessage({ kind: "error", text: "Connect the request wallet before cancelling." }); return; }
    if (!quotePoolAddress) { setMessage({ kind: "error", text: "Configure NEXT_PUBLIC_QUOTE_POOL_ADDRESS before cancelling." }); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const requestCode = await loadScript("pool_sell_request.pool_sell_request.spend");
      const requestScript = { type: "PlutusV3" as const, script: tools.applyParamsToScript(requestCode.script, [addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, quotePoolAddress) as import("@lucid-evolution/lucid").Data]) };
      const tx = await lucid.newTx().collectFrom([request.utxo], tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(requestScript).pay.ToAddress(request.seller, { ...request.utxo.assets }).addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      setMessage({ kind: "success", text: "Pool sell request cancelled: " + hash }); setMarketplaceToast("Pool request cancellation submitted: " + hash); await refresh();
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "The pool sell request could not be cancelled." }); }
    finally { setLoading(false); }
  }

  function beginEdit(listing: Listing) { setEditing(listing); setEditPrice(listing.price.toString()); }
  async function updateListing(listing: Listing) {
    if (!lucid || !address || !listing.managed) { setMessage({ kind: "error", text: "Connect the listing management wallet before updating." }); return; }
    setLoading(true);
    try {
      const price = BigInt(editPrice);
      if (price <= BigInt(0)) throw new Error("Updated price must be greater than zero.");
      const tools = await import("@lucid-evolution/lucid");
      const root = getConstr(tools.Data.from(listing.utxo.datum ?? ""), "listing");
      const nextDatum = new tools.Constr(0, [root.fields[0], root.fields[1], root.fields[2], root.fields[3], listing.quantity, root.fields[5], price]);
      const nextValue = { lovelace: listing.lockedLovelace, [unit(listing.rwa)]: listing.quantity };
      const tx = lucid.newTx().collectFrom([listing.utxo], tools.Data.to(new tools.Constr(2, [nextDatum]) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(await loadListingScript(listing.utxo.address, tools)).pay.ToContract(orderbookAddress, { kind: "inline", value: tools.Data.to(nextDatum as import("@lucid-evolution/lucid").Data) }, nextValue).addSigner(address);
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
      setEditing(null); setMessage({ kind: "success", text: "Update submitted: " + hash }); setMarketplaceToast("Listing update submitted: " + hash); await refresh();
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Listing update was cancelled or failed." }); }
    finally { setLoading(false); }
  }

  const renderListing = (listing: Listing) => {
    const owned = listing.managed;
    const purchaseSubmitted = purchasedListingIds.has(listing.id);
    const tokenName = assetNameText(listing.rwa.assetName);
    const originalName = listing.fraction ? assetNameText(listing.fraction.original.assetName) : "";
    return <article className={"marketplace-listing " + (listingLayout === "card" ? "marketplace-trading-card" : "")} key={listing.id}>
      <div className="marketplace-asset">
        <>{thumbnails[unit(listing.rwa)] ? <Image className="marketplace-thumbnail" src={thumbnails[unit(listing.rwa)]} alt={tokenName + " thumbnail"} width={56} height={56} unoptimized /> : <span className={"marketplace-asset-mark " + (listing.fraction ? "fraction" : "")}>{listing.fraction ? "ƒ" : "RWA"}</span>}</>
        <div>
          <strong>{tokenName} × {listing.quantity.toString()}</strong>
          <code>{listing.rwa.policyId}{listing.rwa.assetName}</code>
          {listing.fraction && <span className="marketplace-fraction-detail">Fraction of {originalName} · total supply {listing.fraction.totalFractions.toString()}</span>}
          <span className={listing.settlement === "pool" ? "marketplace-badge pool" : "marketplace-badge"}>{listing.settlement === "pool" ? "Pool owned" : "P2P seller"}</span>
        </div>
      </div>
      <div>
        <span className="marketplace-listing-label">Price</span>
        <strong className="marketplace-listing-value">{listing.priceAsset.policyId ? listing.price.toString() : formatAda(listing.price)} <small>{listing.priceAsset.policyId ? assetNameText(listing.priceAsset.assetName) : "ADA"}</small></strong>
      </div>
      <div className="marketplace-actions">
        {purchaseSubmitted ? <button type="button" className="primary" disabled>Purchase submitted</button> : owned ? <><button type="button" className="primary" disabled title="This wallet created the listing">Your listing</button>{listing.settlement === "direct" && <><button type="button" onClick={() => beginEdit(listing)} disabled={loading}>Edit</button><button type="button" onClick={() => void cancelListing(listing)} disabled={loading}>Cancel</button></>}</> : !lucid || !address ? <button type="button" className="primary" onClick={() => void connect()} disabled={loading}>Connect wallet to buy</button> : <button type="button" className="primary" onClick={() => void buyListing(listing)} disabled={loading}>Buy</button>}
      </div>
    </article>;
  };

  const renderSection = (title: string, kicker: string, items: Listing[], empty: string) => {
    const isListedTokens = kicker === "P2P orderbook";
    return <section className="marketplace-book">
      <div className="marketplace-book-head"><div><span className="section-kicker">{kicker}</span><h3>{title}</h3></div><div className="marketplace-book-controls">{isListedTokens && <div className="marketplace-layout-toggle" role="group" aria-label="Listed token layout"><button type="button" className={listingLayout === "card" ? "selected" : ""} onClick={() => setListingLayout("card")}>Card view</button><button type="button" className={listingLayout === "list" ? "selected" : ""} onClick={() => setListingLayout("list")}>List view</button></div>}<span className="marketplace-count">{loaded ? items.length + " available" : "Connect to load"}</span></div></div>
      {!orderbookAddress && <p className="marketplace-empty">Set <code>NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS</code> to discover this book.</p>}
      {orderbookAddress && !lucid && <p className="marketplace-empty">Connect Eternl to inspect the orderbook.</p>}
      {orderbookAddress && lucid && loaded && items.length === 0 && <p className="marketplace-empty">{empty}</p>}
      {orderbookAddress && lucid && items.length > 0 && <div className={"marketplace-list " + (isListedTokens && listingLayout === "card" ? "marketplace-card-grid" : "")}>{items.map(renderListing)}</div>}
    </section>;
  };
  const renderRequest = (request: PoolSellRequest) => <article className="marketplace-listing" key={request.id}>
    <div className="marketplace-asset"><span className="marketplace-asset-mark">⇢</span><div><strong>{assetNameText(request.rwa.assetName)} × {request.quantity.toString()}</strong><code>{request.rwa.policyId}{request.rwa.assetName}</code><span className="marketplace-badge">Awaiting pool pickup</span></div></div>
    <div><span className="marketplace-listing-label">Price</span><strong className="marketplace-listing-value">{request.quoteAsset.policyId ? request.minPayout.toString() : formatAda(request.minPayout)} <small>{request.quoteAsset.policyId ? assetNameText(request.quoteAsset.assetName) : "ADA"}</small></strong></div>
    <div className="marketplace-actions">{request.managed ? <button type="button" onClick={() => void cancelPoolSellRequest(request)} disabled={loading}>Cancel request</button> : <span className="explorer-link muted-link">Pool batcher may settle</span>}</div>
  </article>;

  return <div className="marketplace-workbench">
    <section className="marketplace-card">
      <div className="section-heading"><div><span className="section-kicker">{ownerOnly ? "Your marketplace activity" : "Orderbook / shared settlement"}</span><h2>{ownerOnly ? "Manage your listings" : "Trade RWA ownership"}</h2></div><span className="step-badge">{orderbookAddress ? "Contract configured" : "Address needed"}</span></div>
      <p className="marketplace-intro">{ownerOnly ? "Update listing prices, cancel open listings and track requests awaiting operator settlement." : "Browse direct P2P listings and pool-owned inventory in one orderbook."}</p>
      <div className="marketplace-toolbar">
        <span className="wallet-assets-note">{ownerOnly ? "Only listings and requests owned by the connected wallet appear here." : "Buy listed assets here."}</span>
        <div className="marketplace-toolbar-actions"><button className="marketplace-refresh" type="button" onClick={() => void refresh()} disabled={!lucid || loading}>{loading ? "Loading…" : "Refresh"}</button></div>
      </div>
      {message && <p className={message.kind === "error" ? "marketplace-message marketplace-error" : "marketplace-message marketplace-success"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      <div className="marketplace-market-summary"><div><span>{ownerOnly ? "Your direct listings" : "Direct listings"}</span><strong>{lucid && loaded && !loading && message?.kind !== "error" ? p2pListings.length : "—"}</strong></div>{!ownerOnly && <div><span>Pool inventory</span><strong>{lucid && loaded && !loading && message?.kind !== "error" ? poolListings.length : "—"}</strong></div>}{ownerOnly && <div><span>Your Instant Sell requests</span><strong>{lucid && loaded && !loading && message?.kind !== "error" ? sellRequests.length : "—"}</strong></div>}</div>
    </section>
    {marketplaceToast && <div className="marketplace-toast" role="status"><strong>Marketplace updated</strong><span>{marketplaceToast}</span><button type="button" onClick={() => setMarketplaceToast(null)} aria-label="Dismiss Marketplace notification">×</button></div>}
    {editing && <div className="marketplace-edit-backdrop" role="presentation" onMouseDown={() => !loading && setEditing(null)}><section className="marketplace-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="marketplace-edit-title" onMouseDown={(event) => event.stopPropagation()}><div className="listing-dialog-heading"><div><span className="section-kicker">Marketplace listing</span><h2 id="marketplace-edit-title">Edit price</h2></div><button type="button" className="listing-dialog-close" onClick={() => setEditing(null)} disabled={loading} aria-label="Close edit dialog">×</button></div><p>Update the price for {assetNameText(editing.rwa.assetName)}. The listed quantity remains {editing.quantity.toString()}.</p><label className="field"><span className="field-label">Price in base units</span><input autoFocus inputMode="numeric" pattern="[0-9]+" min="1" value={editPrice} onChange={(event) => setEditPrice(event.target.value)} /></label><div className="marketplace-edit-dialog-actions"><button type="button" onClick={() => setEditing(null)} disabled={loading}>Cancel</button><button type="button" className="primary-button" onClick={() => void updateListing(editing)} disabled={loading}>{loading ? "Awaiting wallet…" : "Save price"}</button></div></section></div>}
    <section className="marketplace-listings">
      {ownerOnly && sellRequests.length > 0 && <section className="marketplace-book"><div className="marketplace-book-head"><div><span className="section-kicker">Shared-pool requests</span><h3>Awaiting pool pickup</h3></div><span className="marketplace-count">{sellRequests.length} pending</span></div><p className="directory-intro">A batcher can settle a request only with the shared pool and only at or above its minimum payout. Request owners can cancel at any time.</p><div className="marketplace-list">{sellRequests.map(renderRequest)}</div></section>}
      {renderSection(ownerOnly ? "Your direct listings" : "Listed tokens", "P2P orderbook", p2pListings, ownerOnly ? "You have no open direct listings. Select an asset in Portfolio to create one." : "No direct user listings are currently open.")}
      {!ownerOnly && renderSection("Available tokens", "Shared pool inventory", poolListings, "No pool-owned inventory is currently available.")}
    </section>
  </div>;

}
