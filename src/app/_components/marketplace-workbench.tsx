"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useWallet } from "./wallet-context";
import { marketplaceOrderbookAddress, marketplacePoolAddress } from "@/lib/protocol/marketplace-deployment";

type Mode = "all" | "price" | "instant";
type MarketplaceView = "all" | "p2p" | "pool" | "fractions";
type ListingLayout = "card" | "list";
type AssetClass = { policyId: string; assetName: string };
type Constr = { index: number; fields: unknown[] };
type FractionInfo = { fraction: AssetClass; original: AssetClass; totalFractions: bigint };
type FormState = { policyId: string; assetName: string; quantity: string; pricePolicyId: string; priceAssetName: string; price: string; proceeds: string };
type Listing = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; seller: string; sellerKey: string; managed: boolean; settlement: "direct" | "pool"; poolToken?: AssetClass; inventoryToken?: AssetClass; fraction?: FractionInfo; rwa: AssetClass; quantity: bigint; priceAsset: AssetClass; price: bigint; lockedLovelace: bigint };
type PoolSellRequest = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; seller: string; sellerKey: string; managed: boolean; poolToken: AssetClass; rwa: AssetClass; quantity: bigint; quoteAsset: AssetClass; minPayout: bigint; lockedLovelace: bigint };

const initialForm: FormState = { policyId: "", assetName: "", quantity: "1", pricePolicyId: "", priceAssetName: "", price: "", proceeds: "" };

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
function getAddress(value: unknown, tools: { credentialToAddress: (network: "Preprod" | "Mainnet", payment: { type: "Key" | "Script"; hash: string }, stake?: { type: "Key" | "Script"; hash: string }) => string }): string {
  const root = getConstr(value, "seller address");
  if (root.index !== 0 || root.fields.length !== 2) throw new Error("Malformed seller address.");
  const credential = (raw: unknown) => {
    const c = getConstr(raw, "credential");
    if (c.fields.length !== 1 || typeof c.fields[0] !== "string") throw new Error("Malformed credential.");
    return { type: c.index === 0 ? "Key" as const : "Script" as const, hash: c.fields[0] };
  };
  const payment = credential(root.fields[0]);
  const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "mainnet" ? "Mainnet" as const : "Preprod" as const;
  if (root.fields[1] === null) return tools.credentialToAddress(network, payment);
  const stake = getConstr(root.fields[1], "staking credential");
  if (stake.index !== 0 || stake.fields.length !== 1) throw new Error("Malformed staking credential.");
  const stakingHash = getConstr(stake.fields[0], "staking hash");
  if (stakingHash.index !== 0 || stakingHash.fields.length !== 1) throw new Error("Malformed staking hash.");
  return tools.credentialToAddress(network, payment, credential(stakingHash.fields[0]));
}
function decodeListing(utxo: import("@lucid-evolution/lucid").UTxO, tools: { Data: { from: (raw: string) => unknown }; credentialToAddress: (network: "Preprod" | "Mainnet", payment: { type: "Key" | "Script"; hash: string }, stake?: { type: "Key" | "Script"; hash: string }) => string }): Listing {
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
function validateHex(value: string, label: string, allowEmpty = false): string {
  const normalized = value.trim().toLowerCase();
  if ((!allowEmpty && !normalized) || !/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) throw new Error(label + " must be even-length hexadecimal.");
  return normalized;
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
function encodeListing(tools: typeof import("@lucid-evolution/lucid"), form: FormState, address: string) {
  const policyId = validateHex(form.policyId, "Listed policy ID");
  const assetName = validateHex(form.assetName, "Listed asset name", true);
  const pricePolicyId = form.pricePolicyId.trim() ? validateHex(form.pricePolicyId, "Requested policy ID") : "";
  const priceAssetName = pricePolicyId ? validateHex(form.priceAssetName, "Requested asset name", true) : "";
  const quantity = BigInt(form.quantity);
  const price = BigInt(form.price);
  if (policyId.length !== 56 || (pricePolicyId && pricePolicyId.length !== 56)) throw new Error("Policy IDs must be 28 bytes (56 hex characters).");
  if (quantity <= BigInt(0) || price <= BigInt(0)) throw new Error("Quantity and minimum payout must be greater than zero.");
  if (policyId === pricePolicyId && assetName === priceAssetName) throw new Error("The requested asset cannot be the listed asset.");
  const details = tools.getAddressDetails(address);
  if (!details?.paymentCredential || details.paymentCredential.type !== "Key") throw new Error("The connected wallet needs a payment-key address.");
  const datum = new tools.Constr(0, [addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, form.proceeds.trim() || address), details.paymentCredential.hash, new tools.Constr(0, []), assetData(tools.Constr, { policyId, assetName }), quantity, assetData(tools.Constr, { policyId: pricePolicyId, assetName: priceAssetName }), price]);
  return { datum, policyId, assetName, quantity };
}
function decodePoolSellRequest(utxo: import("@lucid-evolution/lucid").UTxO, tools: { Data: { from: (raw: string) => unknown }; credentialToAddress: (network: "Preprod" | "Mainnet", payment: { type: "Key" | "Script"; hash: string }, stake?: { type: "Key" | "Script"; hash: string }) => string }): PoolSellRequest {
  if (!utxo.datum) throw new Error("Pool sell request has no datum.");
  const root = getConstr(tools.Data.from(utxo.datum), "pool sell request");
  if (root.index !== 0 || root.fields.length !== 7 || typeof root.fields[1] !== "string" || typeof root.fields[4] !== "bigint" || typeof root.fields[6] !== "bigint") throw new Error("Not a pool sell request datum.");
  return { id: utxo.txHash + "#" + utxo.outputIndex, utxo, seller: getAddress(root.fields[0], tools), sellerKey: root.fields[1], managed: false, poolToken: getAsset(root.fields[2], "request pool token"), rwa: getAsset(root.fields[3], "requested RWA"), quantity: root.fields[4], quoteAsset: getAsset(root.fields[5], "request quote asset"), minPayout: root.fields[6], lockedLovelace: utxo.assets.lovelace };
}
function encodePoolSellRequest(tools: typeof import("@lucid-evolution/lucid"), form: FormState, address: string, poolToken: AssetClass, quoteAsset: AssetClass) {
  const policyId = validateHex(form.policyId, "Listed policy ID");
  const assetName = validateHex(form.assetName, "Listed asset name", true);
  const pricePolicyId = form.pricePolicyId.trim() ? validateHex(form.pricePolicyId, "Requested policy ID") : "";
  const priceAssetName = pricePolicyId ? validateHex(form.priceAssetName, "Requested asset name", true) : "";
  const quantity = BigInt(form.quantity);
  const minPayout = BigInt(form.price);
  if (policyId.length !== 56 || (pricePolicyId && pricePolicyId.length !== 56)) throw new Error("Policy IDs must be 28 bytes (56 hex characters).");
  if (quantity <= BigInt(0) || minPayout <= BigInt(0)) throw new Error("Quantity and minimum payout must be greater than zero.");
  const rwa = { policyId, assetName };
  const requested = { policyId: pricePolicyId, assetName: priceAssetName };
  if (sameAsset(rwa, requested)) throw new Error("The requested asset cannot be the listed asset.");
  if (!sameAsset(requested, quoteAsset)) throw new Error("The minimum payout asset must match the shared pool quote asset.");
  const details = tools.getAddressDetails(address);
  if (!details?.paymentCredential || details.paymentCredential.type !== "Key") throw new Error("The connected wallet needs a payment-key address.");
  const seller = form.proceeds.trim() || address;
  const datum = new tools.Constr(0, [addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, seller), details.paymentCredential.hash, assetData(tools.Constr, poolToken), assetData(tools.Constr, rwa), quantity, assetData(tools.Constr, requested), minPayout]);
  return { datum, policyId, assetName, quantity };
}

export default function MarketplaceWorkbench() {
  const { address, lucid, connect } = useWallet();
  const [form, setForm] = useState<FormState>(initialForm);
  const [showListingForm, setShowListingForm] = useState(false);
  const [mode, setMode] = useState<Exclude<Mode, "all">>("price");
  const [view, setView] = useState<MarketplaceView>("all");
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

  useEffect(() => {
    const asset = new URLSearchParams(window.location.search).get("asset") ?? "";
    if (asset.length < 56) return;
    setForm({ ...initialForm, policyId: asset.slice(0, 56), assetName: asset.slice(56) });
    setShowListingForm(true);
  }, []);

  const refresh = useCallback(async () => {
    setMessage(null);
    if (!lucid || !orderbookAddress) { setListings([]); setLoaded(true); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      let fractions = new Map<string, FractionInfo>();
      try { fractions = await loadFractionIndex(lucid); } catch { /* Fraction metadata is optional for generic listings. */ }
      const found: Listing[] = [];
      const response = await fetch("/api/blockfrost/addresses/" + encodeURIComponent(orderbookAddress) + "/utxos?count=100", { cache: "no-store" });
      const outputs = await response.json().catch(() => []) as Array<{ tx_hash?: unknown; output_index?: unknown; inline_datum?: unknown; amount?: Array<{ unit?: unknown; quantity?: unknown }> }>;
      const orderbookUtxos = outputs.flatMap((output) => {
        if (typeof output.tx_hash !== "string" || typeof output.output_index !== "number" || typeof output.inline_datum !== "string" || !Array.isArray(output.amount)) return [];
        const assets = Object.fromEntries(output.amount.flatMap((entry) => typeof entry.unit === "string" && typeof entry.quantity === "string" ? [[entry.unit, BigInt(entry.quantity)]] : []));
        return [{ txHash: output.tx_hash, outputIndex: output.output_index, address: orderbookAddress, assets, datum: output.inline_datum } as import("@lucid-evolution/lucid").UTxO];
      });
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
      setListings(found); setSellRequests(requests); setLoaded(true);
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to read orderbook listings." });
    } finally { setLoading(false); }
  }, [address, lucid, orderbookAddress, quotePoolAddress]);

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
  const visible = useMemo(() => listings
    .filter((listing) => view === "all" || (view === "p2p" && listing.settlement === "direct") || (view === "pool" && listing.settlement === "pool") || (view === "fractions" && Boolean(listing.fraction))), [listings, view]);
  const p2pListings = useMemo(() => visible.filter((listing) => listing.settlement === "direct"), [visible]);
  const poolListings = useMemo(() => visible.filter((listing) => listing.settlement === "pool"), [visible]);
  const update = (key: keyof FormState, value: string) => { setForm((current) => ({ ...current, [key]: value })); setMessage(null); };

  async function createListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    if (!lucid || !address) { setMessage({ kind: "error", text: "Connect Eternl before creating a listing." }); return; }
    if (!orderbookAddress) { setMessage({ kind: "error", text: "Set NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS to the deployed registry-free orderbook script address." }); return; }
    if (mode === "instant" && !quotePoolAddress) { setMessage({ kind: "error", text: "Set NEXT_PUBLIC_QUOTE_POOL_ADDRESS to submit a shared-pool sell request." }); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      let destination = orderbookAddress;
      let encoded: ReturnType<typeof encodeListing> | ReturnType<typeof encodePoolSellRequest>;
      if (mode === "instant") {
        const poolUtxo = (await lucid.utxosAt(quotePoolAddress)).find((utxo) => utxo.datum && (() => { try { const datum = getConstr(tools.Data.from(utxo.datum!), "quote pool"); return datum.index === 0 && datum.fields.length === 10; } catch { return false; } })());
        if (!poolUtxo?.datum) throw new Error("No active shared-pool state was found.");
        const poolDatum = getConstr(tools.Data.from(poolUtxo.datum), "quote pool");
        const poolToken = getAsset(poolDatum.fields[2], "pool token");
        const quoteAsset = getAsset(poolDatum.fields[5], "pool quote asset");
        encoded = encodePoolSellRequest(tools, form, address, poolToken, quoteAsset);
        const requestCode = await loadScript("pool_sell_request.pool_sell_request.spend");
        const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "mainnet" ? "Mainnet" as const : "Preprod" as const;
        destination = tools.validatorToAddress(network, { type: "PlutusV3", script: tools.applyParamsToScript(requestCode.script, [addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, quotePoolAddress) as import("@lucid-evolution/lucid").Data]) });
      } else {
        encoded = encodeListing(tools, form, address);
      }
      const escrow = { lovelace: BigInt(2000000), [unit({ policyId: encoded.policyId, assetName: encoded.assetName })]: encoded.quantity };
      const tx = await lucid.newTx().pay.ToContract(destination, { kind: "inline", value: tools.Data.to(encoded.datum as import("@lucid-evolution/lucid").Data) }, escrow).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      setForm({ ...initialForm, proceeds: address }); setMessage({ kind: "success", text: (mode === "instant" ? "Pool sell request submitted: " : "Listing submitted: ") + hash + ". It will appear after confirmation." }); await refresh(); [5_000, 15_000, 30_000].forEach((delay) => window.setTimeout(() => { void refresh(); }, delay));
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Listing creation was cancelled or failed." }); }
    finally { setLoading(false); }
  }

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
        <strong className="marketplace-listing-value">{listing.price.toString()} <small>{listing.priceAsset.policyId ? assetNameText(listing.priceAsset.assetName) : "ADA"}</small></strong>
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
    <div><span className="marketplace-listing-label">Price</span><strong className="marketplace-listing-value">{request.minPayout.toString()} <small>{request.quoteAsset.policyId ? assetNameText(request.quoteAsset.assetName) : "ADA"}</small></strong></div>
    <div className="marketplace-actions">{request.managed ? <button type="button" onClick={() => void cancelPoolSellRequest(request)} disabled={loading}>Cancel request</button> : <span className="explorer-link muted-link">Pool batcher may settle</span>}</div>
  </article>;

  return <div className="marketplace-workbench">
    <section className="marketplace-card">
      <div className="section-heading"><div><span className="section-kicker">Orderbook / shared settlement</span><h2>Trade RWA and fractional ownership</h2></div><span className="step-badge">{orderbookAddress ? "Contract ready" : "Address needed"}</span></div>
      <p className="marketplace-intro">Browse direct P2P listings and pool-owned inventory in one orderbook.</p>
      <div className="marketplace-toolbar">
        <span className="wallet-assets-note">Choose a direct listing or request an instant shared-pool sale.</span>
        <div className="marketplace-toolbar-actions"><button type="button" className="marketplace-refresh" onClick={() => { setShowListingForm((visible) => !visible); setMessage(null); }}>{showListingForm ? "Close sell form" : "Sell an asset"}</button><button className="marketplace-refresh" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Loading…" : "Refresh books"}</button></div>
      </div>
      {message && <p className={message.kind === "error" ? "marketplace-message marketplace-error" : "marketplace-message marketplace-success"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      <div className="marketplace-market-summary"><div><span>Direct listings</span><strong>{p2pListings.length}</strong></div><div><span>Pool inventory</span><strong>{poolListings.length}</strong></div><div><span>Instant-sell requests</span><strong>{sellRequests.length}</strong></div></div>
      <div className="marketplace-view-tabs" role="tablist" aria-label="Marketplace inventory">
        <button type="button" className={view === "all" ? "selected" : ""} onClick={() => setView("all")}>Overview</button>
        <button type="button" className={view === "p2p" ? "selected" : ""} onClick={() => setView("p2p")}>Listed tokens</button>
        <button type="button" className={view === "pool" ? "selected" : ""} onClick={() => setView("pool")}>Pool owned</button>
        <button type="button" className={view === "fractions" ? "selected" : ""} onClick={() => setView("fractions")}>Fractions</button>
      </div>
      {showListingForm && <form onSubmit={createListing}>
        <div className="marketplace-sell-mode" role="group" aria-label="How to sell"><button type="button" className={mode === "price" ? "selected" : ""} onClick={() => setMode("price")}>List at my price</button><button type="button" className={mode === "instant" ? "selected" : ""} onClick={() => setMode("instant")}>Instant sell to pool</button></div>
        <div className="marketplace-form-grid"><label className="field"><span className="field-label">Listed policy ID</span><input value={form.policyId} onChange={(event) => update("policyId", event.target.value)} placeholder="28-byte policy ID (hex)" /></label><label className="field"><span className="field-label">Listed asset name</span><input value={form.assetName} onChange={(event) => update("assetName", event.target.value)} placeholder="Asset name (hex)" /></label><label className="field"><span className="field-label">Quantity</span><input inputMode="numeric" value={form.quantity} onChange={(event) => update("quantity", event.target.value)} placeholder="1" /></label><label className="field"><span className="field-label">{mode === "instant" ? "Minimum pool payout" : "Listing price"}</span><input inputMode="numeric" value={form.price} onChange={(event) => update("price", event.target.value)} placeholder="Smallest quote units" /></label><label className="field"><span className="field-label">{mode === "instant" ? "Pool quote policy ID (blank for ADA)" : "Requested policy ID (blank for ADA)"}</span><input value={form.pricePolicyId} onChange={(event) => update("pricePolicyId", event.target.value)} placeholder="Blank = ADA" /></label><label className="field"><span className="field-label">{mode === "instant" ? "Pool quote asset name" : "Requested asset name"}</span><input value={form.priceAssetName} onChange={(event) => update("priceAssetName", event.target.value)} placeholder="Asset name (hex)" disabled={!form.pricePolicyId} /></label><label className="field field-wide"><span className="field-label">Proceeds address</span><input value={form.proceeds || address} onChange={(event) => update("proceeds", event.target.value)} placeholder="Defaults to connected wallet" /></label></div>
        <div className="marketplace-mode-note"><b>{mode === "instant" ? ">" : "-"}</b><div><strong>{mode === "instant" ? "Shared-pool sell request" : "Sell at a price"}</strong><span>{mode === "instant" ? "Your asset is escrowed for the pool batcher; it can only settle at or above your on-chain minimum, or you can cancel it with your wallet." : "Any buyer can consume the listing when payment reaches the proceeds address."}</span></div></div>
        <div className="marketplace-contract-note"><span>*</span><div>{mode === "instant" ? <>Uses <code>pool_sell_request</code> and the configured shared pool. Settlement requires the pool batcher; no signing key is exposed to the browser.</> : <>Uses <code>p2p_listing_simple</code>; no registry reference is required. Fraction listings use the exact fraction asset unit.</>}</div></div>
        {message && <p className={message.kind === "error" ? "marketplace-message marketplace-error" : "marketplace-message marketplace-success"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
        <div className="marketplace-form-footer"><p><span className="status-dot" />{lucid ? " Eternl connected - ready to sign." : " Connect Eternl to prepare a transaction."}</p><button type="submit" className="primary-button" disabled={loading}>{loading ? "Awaiting wallet..." : mode === "instant" ? "Submit pool request" : "Create listing"} <span className="button-arrow">Go</span></button></div>
      </form>}
    </section>
    {marketplaceToast && <div className="marketplace-toast" role="status"><strong>Marketplace updated</strong><span>{marketplaceToast}</span><button type="button" onClick={() => setMarketplaceToast(null)} aria-label="Dismiss Marketplace notification">×</button></div>}
    {editing && <div className="marketplace-edit-backdrop" role="presentation" onMouseDown={() => !loading && setEditing(null)}><section className="marketplace-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="marketplace-edit-title" onMouseDown={(event) => event.stopPropagation()}><div className="listing-dialog-heading"><div><span className="section-kicker">Marketplace listing</span><h2 id="marketplace-edit-title">Edit price</h2></div><button type="button" className="listing-dialog-close" onClick={() => setEditing(null)} disabled={loading} aria-label="Close edit dialog">×</button></div><p>Update the price for {assetNameText(editing.rwa.assetName)}. The listed quantity remains {editing.quantity.toString()}.</p><label className="field"><span className="field-label">Price in base units</span><input autoFocus inputMode="numeric" pattern="[0-9]+" min="1" value={editPrice} onChange={(event) => setEditPrice(event.target.value)} /></label><div className="marketplace-edit-dialog-actions"><button type="button" onClick={() => setEditing(null)} disabled={loading}>Cancel</button><button type="button" className="primary-button" onClick={() => void updateListing(editing)} disabled={loading}>{loading ? "Awaiting wallet…" : "Save price"}</button></div></section></div>}
    <section className="marketplace-listings">
      {sellRequests.length > 0 && <section className="marketplace-book"><div className="marketplace-book-head"><div><span className="section-kicker">Shared-pool requests</span><h3>Awaiting pool pickup</h3></div><span className="marketplace-count">{sellRequests.length} pending</span></div><p className="directory-intro">A batcher can settle a request only with the shared pool and only at or above its minimum payout. Request owners can cancel at any time.</p><div className="marketplace-list">{sellRequests.map(renderRequest)}</div></section>}
      {view !== "pool" && renderSection(view === "fractions" ? "Fraction P2P listings" : "Listed tokens", "P2P orderbook", p2pListings, view === "fractions" ? "No fraction tokens are currently listed by users." : "No direct user listings are currently open.")}
      {view !== "p2p" && renderSection(view === "fractions" ? "Fraction pool inventory" : "Available tokens", "Shared pool inventory", poolListings, view === "fractions" ? "No fractional tokens are currently available from the pool." : "No pool-owned inventory is currently available.")}
    </section>
  </div>;

}
