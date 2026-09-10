"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "./wallet-context";
import { readRegistry, registryConfigured } from "@/lib/asset-registry";

type Mode = "all" | "price" | "instant";
type MarketplaceView = "all" | "p2p" | "pool" | "fractions";
type AssetClass = { policyId: string; assetName: string };
type Constr = { index: number; fields: unknown[] };
type FractionInfo = { fraction: AssetClass; original: AssetClass; totalFractions: bigint };
type FormState = { policyId: string; assetName: string; quantity: string; pricePolicyId: string; priceAssetName: string; price: string; proceeds: string };
type Listing = { id: string; utxo: import("@lucid-evolution/lucid").UTxO; seller: string; sellerKey: string; managed: boolean; settlement: "direct" | "pool"; poolToken?: AssetClass; inventoryToken?: AssetClass; fraction?: FractionInfo; rwa: AssetClass; quantity: bigint; priceAsset: AssetClass; price: bigint; lockedLovelace: bigint };

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
  return tools.credentialToAddress(network, payment, credential(stake.fields[0]));
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
      if (root.index !== 0 || root.fields.length !== 7 || typeof root.fields[1] !== "string" || typeof root.fields[2] !== "string" || typeof root.fields[3] !== "string" || typeof root.fields[4] !== "string" || typeof root.fields[5] !== "bigint") continue;
      const original = { policyId: root.fields[1], assetName: root.fields[2] };
      const fraction = { policyId: root.fields[3], assetName: root.fields[4] };
      index.set(unit(fraction), { fraction, original, totalFractions: root.fields[5] });
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

export default function MarketplaceWorkbench() {
  const { address, lucid } = useWallet();
  const [form, setForm] = useState<FormState>(initialForm);
  const [mode, setMode] = useState<Mode>("price");
  const [registeredOnly, setRegisteredOnly] = useState(false);
  const [registeredAssets, setRegisteredAssets] = useState<Set<string> | null>(null);
  const [registryError, setRegistryError] = useState("");
  const [view, setView] = useState<MarketplaceView>("all");
  const [listings, setListings] = useState<Listing[]>([]);
  const [editing, setEditing] = useState<Listing | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const orderbookAddress = process.env.NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS ?? "";

  const refresh = useCallback(async () => {
    setMessage(null);
    if (!lucid || !orderbookAddress) { setListings([]); setLoaded(true); return; }
    setLoading(true);
    setRegisteredAssets(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      let fractions = new Map<string, FractionInfo>();
      try { fractions = await loadFractionIndex(lucid); } catch { /* Fraction metadata is optional for generic listings. */ }
      let approved: Set<string> | null = null;
      let approvalError = "";
      if (registryConfigured) {
        try { approved = new Set((await readRegistry(lucid)).entries); }
        catch { approvalError = "Registry verification unavailable. Registered-only results are hidden until a successful refresh."; }
      }
      setRegisteredAssets(approved); setRegistryError(approvalError);
      const found: Listing[] = [];
      for (const utxo of await lucid.utxosAt(orderbookAddress)) {
        if (!utxo.datum) continue;
        try {
          const listing = decodeListing(utxo, tools);
          const details = address ? tools.getAddressDetails(address) : undefined;
          const managed = details?.paymentCredential?.type === "Key" && details.paymentCredential.hash === listing.sellerKey;
          found.push({ ...listing, managed, fraction: fractions.get(unit(listing.rwa)) });
        } catch { /* skip unrelated script UTxOs */ }
      }
      setListings(found); setLoaded(true);
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to read orderbook listings." });
    } finally { setLoading(false); }
  }, [address, lucid, orderbookAddress]);

  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, [refresh]);
  const visible = useMemo(() => listings
    .filter((listing) => !registeredOnly || registeredAssets?.has(unit(listing.rwa)))
    .filter((listing) => view === "all" || (view === "p2p" && listing.settlement === "direct") || (view === "pool" && listing.settlement === "pool") || (view === "fractions" && Boolean(listing.fraction))), [listings, view, registeredOnly, registeredAssets]);
  const p2pListings = useMemo(() => visible.filter((listing) => listing.settlement === "direct"), [visible]);
  const poolListings = useMemo(() => visible.filter((listing) => listing.settlement === "pool"), [visible]);
  const update = (key: keyof FormState, value: string) => { setForm((current) => ({ ...current, [key]: value })); setMessage(null); };

  async function createListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    if (!lucid || !address) { setMessage({ kind: "error", text: "Connect Eternl before creating a listing." }); return; }
    if (!orderbookAddress) { setMessage({ kind: "error", text: "Set NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS to the deployed registry-free orderbook script address." }); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const encoded = encodeListing(tools, form, address);
      const escrow = { lovelace: BigInt(2000000), [unit({ policyId: encoded.policyId, assetName: encoded.assetName })]: encoded.quantity };
      const tx = await lucid.newTx().pay.ToContract(orderbookAddress, { kind: "inline", value: tools.Data.to(encoded.datum as import("@lucid-evolution/lucid").Data) }, escrow).attach.SpendingValidator(await loadScript("p2p_listing_simple.p2p_listing_simple.spend")).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      setForm({ ...initialForm, proceeds: address }); setMessage({ kind: "success", text: "Listing submitted: " + hash }); await refresh();
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Listing creation was cancelled or failed." }); }
    finally { setLoading(false); }
  }

  async function buyListing(listing: Listing) {
    setMessage(null);
    if (!lucid || !address) { setMessage({ kind: "error", text: "Connect Eternl before buying." }); return; }
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const buyer = addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, address);
      let tx = lucid.newTx().collectFrom([listing.utxo], tools.Data.to(new tools.Constr(0, [buyer]) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(await loadScript("p2p_listing_simple.p2p_listing_simple.spend"));
      if (listing.settlement === "direct") {
        tx = tx.pay.ToAddress(listing.seller, listing.priceAsset.policyId ? { [unit(listing.priceAsset)]: listing.price } : { lovelace: listing.price + listing.lockedLovelace }).pay.ToAddress(listing.seller, listing.priceAsset.policyId ? { lovelace: listing.lockedLovelace } : {}).pay.ToAddress(address, { lovelace: BigInt(2000000), [unit(listing.rwa)]: listing.quantity });
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
        const poolRedeemer = new tools.Constr(3, [listing.price, buyer, nextDatum]);
        const poolCode = await loadScript("quote_pool.quote_pool.spend");
        const receiptCode = await loadScript("inventory_policy.inventory_policy.mint");
        const poolScript = { type: "PlutusV3" as const, script: tools.applyParamsToScript(poolCode.script, [addressData(tools.Data, tools.AddressSchema, tools.getAddressDetails, orderbookAddress) as import("@lucid-evolution/lucid").Data]) };
        const receiptPolicy = { type: "PlutusV3" as const, script: tools.applyParamsToScript(receiptCode.script, [assetData(tools.Constr, listing.poolToken) as import("@lucid-evolution/lucid").Data, inventoryToken.assetName as import("@lucid-evolution/lucid").Data, poolRoot.fields[1] as import("@lucid-evolution/lucid").Data]) };
        if (tools.mintingPolicyToId(receiptPolicy) !== inventoryToken.policyId) throw new Error("Pool inventory receipt policy does not match the pool datum.");
        tx = tx.collectFrom([poolUtxo], tools.Data.to(poolRedeemer as import("@lucid-evolution/lucid").Data)).mintAssets({ [unit(inventoryToken)]: -BigInt(1) }, tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(poolScript).attach.MintingPolicy(receiptPolicy).pay.ToContract(poolUtxo.address, { kind: "inline", value: tools.Data.to(nextDatum as import("@lucid-evolution/lucid").Data) }, nextAssets);
      }
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
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
      const tx = await lucid.newTx().collectFrom([listing.utxo], tools.Data.to(new tools.Constr(1, []) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(await loadScript("p2p_listing_simple.p2p_listing_simple.spend")).pay.ToAddress(listing.seller, { ...listing.utxo.assets }).addSigner(address).complete();
      const hash = await (await tx.sign.withWallet().complete()).submit();
      setMessage({ kind: "success", text: "Cancellation submitted: " + hash }); await refresh();
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Cancellation was cancelled or failed." }); }
    finally { setLoading(false); }
  }

  function beginEdit(listing: Listing) { setEditing(listing); setEditQuantity(listing.quantity.toString()); setEditPrice(listing.price.toString()); }
  async function updateListing(listing: Listing) {
    if (!lucid || !address || !listing.managed) { setMessage({ kind: "error", text: "Connect the listing management wallet before updating." }); return; }
    setLoading(true);
    try {
      const quantity = BigInt(editQuantity); const price = BigInt(editPrice);
      if (quantity <= BigInt(0) || price <= BigInt(0)) throw new Error("Updated quantity and price must be greater than zero.");
      const tools = await import("@lucid-evolution/lucid");
      const root = getConstr(tools.Data.from(listing.utxo.datum ?? ""), "listing");
      const nextDatum = new tools.Constr(0, [root.fields[0], root.fields[1], root.fields[2], root.fields[3], quantity, root.fields[5], price]);
      const nextValue = { lovelace: listing.lockedLovelace, [unit(listing.rwa)]: quantity };
      let tx = lucid.newTx().collectFrom([listing.utxo], tools.Data.to(new tools.Constr(2, [nextDatum]) as import("@lucid-evolution/lucid").Data)).attach.SpendingValidator(await loadScript("p2p_listing_simple.p2p_listing_simple.spend")).pay.ToContract(orderbookAddress, { kind: "inline", value: tools.Data.to(nextDatum as import("@lucid-evolution/lucid").Data) }, nextValue).addSigner(address);
      if (quantity < listing.quantity) tx = tx.pay.ToAddress(listing.seller, { [unit(listing.rwa)]: listing.quantity - quantity });
      const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
      setEditing(null); setMessage({ kind: "success", text: "Update submitted: " + hash }); await refresh();
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Listing update was cancelled or failed." }); }
    finally { setLoading(false); }
  }

  const renderListing = (listing: Listing) => {
    const owned = listing.managed;
    const tokenName = assetNameText(listing.rwa.assetName);
    const originalName = listing.fraction ? assetNameText(listing.fraction.original.assetName) : "";
    return <article className="marketplace-listing" key={listing.id}>
      <div className="marketplace-asset">
        <span className={"marketplace-asset-mark " + (listing.fraction ? "fraction" : "")}>{listing.fraction ? "ƒ" : "RWA"}</span>
        <div>
          <strong>{tokenName} × {listing.quantity.toString()}</strong>
          <code>{listing.rwa.policyId}{listing.rwa.assetName}</code>
          {listing.fraction && <span className="marketplace-fraction-detail">Fraction of {originalName} · total supply {listing.fraction.totalFractions.toString()}</span>}
          <span className={listing.settlement === "pool" ? "marketplace-badge pool" : "marketplace-badge"}>{listing.settlement === "pool" ? "Pool owned" : "P2P seller"}</span>
        </div>
      </div>
      <div>
        <span className="marketplace-listing-label">{listing.settlement === "pool" ? "Pool ask" : "Requested payout"}</span>
        <strong className="marketplace-listing-value">{listing.price.toString()} <small>{listing.priceAsset.policyId ? assetNameText(listing.priceAsset.assetName) : "ADA"}</small></strong>
      </div>
      <div>
        <span className="marketplace-listing-label">Escrow</span>
        <strong className="marketplace-listing-value">{(Number(listing.lockedLovelace) / 1000000).toFixed(2)} ADA</strong>
      </div>
      <div className="marketplace-actions">
        {!owned || listing.settlement === "pool" ? <button type="button" className="primary" onClick={() => void buyListing(listing)} disabled={loading}>Buy</button> : <><button type="button" onClick={() => beginEdit(listing)} disabled={loading}>Edit</button><button type="button" onClick={() => void cancelListing(listing)} disabled={loading}>Cancel</button></>}
        {editing?.id === listing.id && owned && <div className="marketplace-edit"><label>Quantity<input inputMode="numeric" value={editQuantity} onChange={(event) => setEditQuantity(event.target.value)} /></label><label>Price<input inputMode="numeric" value={editPrice} onChange={(event) => setEditPrice(event.target.value)} /></label><button type="button" className="primary" onClick={() => void updateListing(listing)} disabled={loading}>Save</button></div>}
      </div>
    </article>;
  };

  const renderSection = (title: string, kicker: string, items: Listing[], empty: string) => <section className="marketplace-book">
    <div className="marketplace-book-head"><div><span className="section-kicker">{kicker}</span><h3>{title}</h3></div><span className="marketplace-count">{loaded ? items.length + " available" : "Connect to load"}</span></div>
    {!orderbookAddress && <p className="marketplace-empty">Set <code>NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS</code> to discover this book.</p>}
    {orderbookAddress && !lucid && <p className="marketplace-empty">Connect Eternl to inspect the orderbook.</p>}
    {orderbookAddress && lucid && loaded && items.length === 0 && <p className="marketplace-empty">{empty}</p>}
    {orderbookAddress && lucid && items.length > 0 && <div className="marketplace-list">{items.map(renderListing)}</div>}
  </section>;

  return <div className="marketplace-workbench">
    <section className="marketplace-card">
      <div className="section-heading"><div><span className="section-kicker">Orderbook / shared settlement</span><h2>Trade RWA and fractional ownership</h2></div><span className="step-badge">{orderbookAddress ? "Contract ready" : "Address needed"}</span></div>
      <p className="marketplace-intro">Browse direct P2P listings and pool-owned inventory in one orderbook. Fraction tokens are identified from the active vaults and can use the same buy, sell, and instant-settlement paths.</p>
      <div className="marketplace-toolbar">
        <div className="marketplace-segments"><button type="button" className={mode === "price" ? "selected" : ""} onClick={() => setMode("price")}>Sell at a price</button><button type="button" className={mode === "instant" ? "selected" : ""} onClick={() => setMode("instant")}>Instant sell</button></div>
        <button className="marketplace-refresh" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Loading…" : "Refresh books"}</button>
      </div>
      <label><input type="checkbox" checked={registeredOnly} disabled={!registryConfigured} onChange={(event) => setRegisteredOnly(event.target.checked)} /> CSWAP-registered assets only</label>
      {!registryConfigured && <p>Configure the asset registry to enable approval filtering. <Link href="/registry">Open registry</Link></p>}
      {registryError && <p role="alert">{registryError}</p>}
      <div className="marketplace-view-tabs" role="tablist" aria-label="Marketplace inventory">
        <button type="button" className={view === "all" ? "selected" : ""} onClick={() => setView("all")}>Overview</button>
        <button type="button" className={view === "p2p" ? "selected" : ""} onClick={() => setView("p2p")}>Listed tokens</button>
        <button type="button" className={view === "pool" ? "selected" : ""} onClick={() => setView("pool")}>Pool owned</button>
        <button type="button" className={view === "fractions" ? "selected" : ""} onClick={() => setView("fractions")}>Fractions</button>
      </div>
      <form onSubmit={createListing}>
        <div className="marketplace-form-grid"><label className="field"><span className="field-label">Listed policy ID</span><input value={form.policyId} onChange={(event) => update("policyId", event.target.value)} placeholder="28-byte policy ID (hex)" /></label><label className="field"><span className="field-label">Listed asset name</span><input value={form.assetName} onChange={(event) => update("assetName", event.target.value)} placeholder="Asset name (hex)" /></label><label className="field"><span className="field-label">Quantity</span><input inputMode="numeric" value={form.quantity} onChange={(event) => update("quantity", event.target.value)} placeholder="1" /></label><label className="field"><span className="field-label">Minimum payout</span><input inputMode="numeric" value={form.price} onChange={(event) => update("price", event.target.value)} placeholder="Smallest quote units" /></label><label className="field"><span className="field-label">Requested policy ID (blank for ADA)</span><input value={form.pricePolicyId} onChange={(event) => update("pricePolicyId", event.target.value)} placeholder="Blank = ADA" /></label><label className="field"><span className="field-label">Requested asset name</span><input value={form.priceAssetName} onChange={(event) => update("priceAssetName", event.target.value)} placeholder="Asset name (hex)" disabled={!form.pricePolicyId} /></label><label className="field field-wide"><span className="field-label">Proceeds address</span><input value={form.proceeds || address} onChange={(event) => update("proceeds", event.target.value)} placeholder="Defaults to connected wallet" /></label></div>
        <div className="marketplace-mode-note"><b>{mode === "instant" ? ">" : "-"}</b><div><strong>{mode === "instant" ? "Instant sell / batcher pickup" : "Sell at a price"}</strong><span>{mode === "instant" ? "The batcher cannot settle below your on-chain minimum." : "Any buyer can consume the listing when payment reaches the proceeds address."}</span></div></div>
        <div className="marketplace-contract-note"><span>*</span><div>Uses <code>p2p_listing_simple</code>; no registry reference is required. Fraction listings use the exact fraction asset unit.</div></div>
        {message && <p className={message.kind === "error" ? "marketplace-message marketplace-error" : "marketplace-message marketplace-success"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
        <div className="marketplace-form-footer"><p><span className="status-dot" />{lucid ? " Eternl connected - ready to sign." : " Connect Eternl to prepare a transaction."}</p><button type="submit" className="primary-button" disabled={loading}>{loading ? "Awaiting wallet..." : "Create listing"} <span className="button-arrow">Go</span></button></div>
      </form>
    </section>
    <section className="marketplace-listings">
      {view !== "pool" && renderSection(view === "fractions" ? "Fraction P2P listings" : "Listed tokens", "P2P orderbook", p2pListings, view === "fractions" ? "No fraction tokens are currently listed by users." : "No direct user listings are currently open.")}
      {view !== "p2p" && renderSection(view === "fractions" ? "Fraction pool inventory" : "Available tokens", "Shared pool inventory", poolListings, view === "fractions" ? "No fractional tokens are currently available from the pool." : "No pool-owned inventory is currently available.")}
    </section>
  </div>;

}
