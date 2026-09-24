import type { Assets, Data, LucidEvolution, Script, UTxO } from "@lucid-evolution/lucid";
type Tools = typeof import("@lucid-evolution/lucid");
type Node = import("@lucid-evolution/lucid").Constr<Data>;
export type MarketAsset = { policyId: string; assetName: string };
export type Ratio = { numerator: bigint; denominator: bigint };
export type PoolPrice = { asset: MarketAsset; buy: Ratio; sell: Ratio };
export type Settlement = { kind: "direct" } | { kind: "instant"; poolToken: MarketAsset } | { kind: "pool"; poolToken: MarketAsset; inventoryToken: MarketAsset; cost: bigint };
export type MarketListing = { id: string; utxo: UTxO; raw: Node; seller: string; sellerKey: string; settlement: Settlement; rwa: MarketAsset; quantity: bigint; priceAsset: MarketAsset; price: bigint; lockedLovelace: bigint };
export type SharedPool = { utxo: UTxO; raw: Node; admin: string; batcher: string; poolToken: MarketAsset; lpToken: MarketAsset; inventoryToken: MarketAsset; quote: MarketAsset; prices: PoolPrice[]; supply: bigint; minimum: bigint; paused: boolean; cost: bigint; inventory: bigint; count: bigint; closing: { recipient: string; key: string } | null; cash: bigint; lpUnit: string };
export type MarketScripts = { orderbook: Script; pool: Script; lp: Script; inventory: Script; orderbookAddress: string; poolAddress: string; references?: UTxO[]; identity?: { script: Script; redeemer: string } };
export const marketUnit = (asset: MarketAsset) => asset.policyId ? asset.policyId + asset.assetName : "lovelace";
export const outputRef = (utxo: UTxO) => `${utxo.txHash}#${utxo.outputIndex}`;
const fail = (label: string): never => { throw new Error(`Invalid ${label}. Updated Marketplace schema / deployment required.`); };
function node(value: unknown, fields: number, index = 0): Node {
  if (!value || typeof value !== "object" || !("index" in value) || value.index !== index || !("fields" in value) || !Array.isArray(value.fields) || value.fields.length !== fields) fail("datum constructor");
  return value as Node;
}
const integer = (value: unknown, label: string, positive = false): bigint => typeof value === "bigint" && value >= (positive ? BigInt(1) : BigInt(0)) ? value : fail(label);
const hash = (value: unknown): string => typeof value === "string" && /^[0-9a-f]{56}$/.test(value) ? value : fail("payment key hash");
export function marketAsset(value: unknown): MarketAsset {
  const [policyId, assetName] = node(value, 2).fields;
  if (typeof policyId !== "string" || typeof assetName !== "string" || !/^(?:[0-9a-f]{56})?$/.test(policyId) || !/^(?:[0-9a-f]{2}){0,32}$/.test(assetName) || (!policyId && assetName)) fail("asset identity");
  return { policyId: policyId as string, assetName: assetName as string };
}
export const marketAssetData = (tools: Tools, asset: MarketAsset) => new tools.Constr(0, [asset.policyId, asset.assetName]);
export function marketAddressData(tools: Tools, address: string): Data {
  const details = tools.getAddressDetails(address);
  if (!details.paymentCredential || details.networkId !== 0) throw new Error("A Preprod payment address is required.");
  const cred = (value: NonNullable<typeof details.paymentCredential>) => value.type === "Key" ? { PubKeyCredential: [value.hash] } : { ScriptCredential: [value.hash] };
  return tools.Data.from(tools.Data.to({ addressCredential: cred(details.paymentCredential), addressStakingCredential: details.stakeCredential ? { StakingHash: [cred(details.stakeCredential)] } : null } as never, tools.AddressSchema as never));
}
function marketAddress(tools: Tools, raw: unknown): string {
  const fields = node(raw, 2).fields;
  const credential = (value: unknown) => {
    const c = value as Node; if (!c || ![0, 1].includes(c.index)) return fail("address credential");
    return { type: c.index === 0 ? "Key" as const : "Script" as const, hash: hash(node(c, 1, c.index).fields[0]) };
  };
  const option = fields[1] as Node;
  const stake = option?.index === 1 ? (node(option, 0, 1), undefined) : credential(node(node(option, 1).fields[0], 1).fields[0]);
  return tools.credentialToAddress("Preprod", credential(fields[0]), stake);
}
export function decodeSettlement(value: unknown): Settlement {
  const raw = value as Node;
  if (raw?.index === 0) { node(raw, 0); return { kind: "direct" }; }
  if (raw?.index === 1) return { kind: "instant", poolToken: marketAsset(node(raw, 1, 1).fields[0]) };
  if (raw?.index === 2) {
    const fields = node(raw, 3, 2).fields;
    return { kind: "pool", poolToken: marketAsset(fields[0]), inventoryToken: marketAsset(fields[1]), cost: integer(fields[2], "acquisition cost", true) };
  }
  return fail("listing settlement");
}
export function decodeMarketListing(tools: Tools, utxo: UTxO): MarketListing {
  if (!utxo.datum) return fail("listing datum");
  const raw = node(tools.Data.from(utxo.datum), 7), f = raw.fields;
  const listing = { id: outputRef(utxo), utxo, raw, seller: marketAddress(tools, f[0]), sellerKey: hash(f[1]), settlement: decodeSettlement(f[2]), rwa: marketAsset(f[3]), quantity: integer(f[4], "listing quantity", true), priceAsset: marketAsset(f[5]), price: integer(f[6], "listing price", true), lockedLovelace: integer(utxo.assets.lovelace, "listing deposit", true) };
  if (!listing.rwa.policyId || marketUnit(listing.rwa) === marketUnit(listing.priceAsset)) fail("listing asset pair");
  const expected = listingAssets(listing);
  if (Object.keys(utxo.assets).length !== Object.keys(expected).length || Object.entries(expected).some(([unit, amount]) => utxo.assets[unit] !== amount)) fail("listing escrow value");
  return listing;
}
function ratio(raw: unknown): Ratio { const f = node(raw, 2).fields; return { numerator: integer(f[0], "price numerator", true), denominator: integer(f[1], "price denominator", true) }; }
export function decodeSharedPool(tools: Tools, utxo: UTxO): SharedPool {
  if (!utxo.datum) return fail("pool datum");
  const value = tools.Data.from(utxo.datum) as Node;
  if (value?.fields?.length === 10) throw new Error("Legacy 10-field shared pool: signing disabled. Deploy/migrate the reviewed 14-field contracts; existing funds are not migrated automatically.");
  const raw = node(value, 14), f = raw.fields;
  if (!Array.isArray(f[6]) || f[6].length > 50) fail("pool prices");
  const prices = (f[6] as Data[]).map((value) => { const p = node(value, 3).fields; return { asset: marketAsset(p[0]), buy: ratio(p[1]), sell: ratio(p[2]) }; });
  if (prices.some((price) => !price.asset.policyId) || new Set(prices.map((price) => marketUnit(price.asset))).size !== prices.length) fail("unique priced assets");
  const flag = f[9] as Node; if (![0, 1].includes(flag?.index)) fail("paused flag"); node(flag, 0, flag.index);
  const option = f[13] as Node;
  let closing: SharedPool["closing"] = null;
  if (option?.index === 1) node(option, 0, 1);
  else { const exit = node(node(option, 1).fields[0], 2).fields; closing = { recipient: marketAddress(tools, exit[0]), key: hash(exit[1]) }; if (tools.getAddressDetails(closing.recipient).paymentCredential?.type !== "Key" || tools.getAddressDetails(closing.recipient).paymentCredential?.hash !== closing.key) fail("closing LP binding"); }
  const quote = marketAsset(f[5]), lpToken = marketAsset(f[3]), poolToken = marketAsset(f[2]), inventoryToken = marketAsset(f[4]);
  if (!poolToken.policyId || !lpToken.policyId || !inventoryToken.policyId || new Set([poolToken, lpToken, inventoryToken, quote].map(marketUnit)).size !== 4 || utxo.assets[marketUnit(poolToken)] !== BigInt(1)) fail("pool identities");
  const supply = integer(f[7], "LP supply"); if (closing && supply !== BigInt(0)) fail("closing supply");
  return { utxo, raw, admin: hash(f[0]), batcher: hash(f[1]), poolToken, lpToken, inventoryToken, quote, prices, supply, minimum: integer(f[8], "protected reserve"), paused: flag.index === 1, cost: integer(f[10], "inventory cost"), inventory: integer(f[11], "inventory ask"), count: integer(f[12], "inventory count"), closing, cash: utxo.assets[marketUnit(quote)] || BigInt(0), lpUnit: marketUnit(lpToken) };
}
export function listingAssets(listing: Pick<MarketListing, "rwa" | "quantity" | "lockedLovelace" | "settlement">): Assets {
  const assets: Assets = { lovelace: listing.lockedLovelace, [marketUnit(listing.rwa)]: listing.quantity };
  if (listing.settlement.kind === "pool") assets[marketUnit(listing.settlement.inventoryToken)] = BigInt(1);
  return assets;
}
export function listingDatum(tools: Tools, listing: Pick<MarketListing, "seller" | "sellerKey" | "settlement" | "rwa" | "quantity" | "priceAsset" | "price">): Node {
  const s = listing.settlement;
  return new tools.Constr(0, [marketAddressData(tools, listing.seller), listing.sellerKey, s.kind === "direct" ? new tools.Constr(0, []) : s.kind === "instant" ? new tools.Constr(1, [marketAssetData(tools, s.poolToken)]) : new tools.Constr(2, [marketAssetData(tools, s.poolToken), marketAssetData(tools, s.inventoryToken), s.cost]), marketAssetData(tools, listing.rwa), listing.quantity, marketAssetData(tools, listing.priceAsset), listing.price]);
}
export function nextPool(tools: Tools, pool: SharedPool, changes: Partial<{ prices: PoolPrice[]; supply: bigint; minimum: bigint; paused: boolean; cost: bigint; inventory: bigint; count: bigint; closing: SharedPool["closing"] }>): Node {
  const state = { ...pool, ...changes };
  const r = (value: Ratio) => new tools.Constr(0, [value.numerator, value.denominator]);
  return new tools.Constr(0, [...pool.raw.fields.slice(0, 6), state.prices.map((price) => new tools.Constr(0, [marketAssetData(tools, price.asset), r(price.buy), r(price.sell)])), state.supply, state.minimum, new tools.Constr(state.paused ? 1 : 0, []), state.cost, state.inventory, state.count, state.closing ? new tools.Constr(0, [new tools.Constr(0, [marketAddressData(tools, state.closing.recipient), state.closing.key])]) : new tools.Constr(1, [])]);
}
export function postedQuote(pool: SharedPool, unit: string, quantity: bigint) {
  if (pool.paused || pool.closing) throw new Error("Pool is paused or closing; new acquisitions are disabled.");
  const price = pool.prices.find((entry) => marketUnit(entry.asset) === unit);
  if (!price || quantity <= BigInt(0)) throw new Error("No active on-chain price for this asset/quantity.");
  const bid = quantity * price.buy.numerator / price.buy.denominator, ask = quantity * price.sell.numerator / price.sell.denominator;
  if (bid <= BigInt(0) || ask <= BigInt(0)) throw new Error("Quantity rounds to a zero payout or ask.");
  if (pool.cash - bid < pool.minimum) throw new Error("Bid exceeds cash above the protected reserve.");
  return { bid, ask };
}
export function lpDeposit(pool: SharedPool, amount: bigint) {
  if (pool.paused || pool.closing || amount <= BigInt(0)) throw new Error("Deposits require a live, non-closing pool and a positive amount.");
  const equity = pool.cash + pool.cost;
  if (pool.supply === BigInt(0) && (pool.count || pool.cost || pool.inventory)) throw new Error("Cannot initialize shares with outstanding inventory.");
  if (pool.supply > BigInt(0) && equity <= BigInt(0)) throw new Error("Pool equity is zero.");
  const minted = pool.supply === BigInt(0) ? amount + equity : amount * pool.supply / equity;
  if (minted <= BigInt(0)) throw new Error("Deposit is too small to mint shares.");
  return minted;
}
export function lpWithdrawal(pool: SharedPool, burned: bigint) {
  if (pool.closing || burned <= BigInt(0) || burned > pool.supply || pool.cash < pool.minimum) throw new Error("Invalid withdrawal amount or pool state.");
  return { amount: burned * (pool.cash - pool.minimum) / pool.supply, final: burned === pool.supply };
}
function delta(assets: Assets, unit: string, amount: bigint): Assets { const next = { ...assets, [unit]: (assets[unit] || BigInt(0)) + amount }; if (next[unit] < BigInt(0)) throw new Error("Insufficient pool value."); if (next[unit] === BigInt(0)) delete next[unit]; return next; }
function keyOf(tools: Tools, address: string) { const details = tools.getAddressDetails(address); if (details.networkId !== 0 || details.paymentCredential?.type !== "Key") throw new Error("Connect a Preprod payment-key wallet."); return details.paymentCredential.hash; }
function bound(listing: MarketListing, pool: SharedPool) {
  const s = listing.settlement;
  if (s.kind !== "pool" || marketUnit(s.poolToken) !== marketUnit(pool.poolToken) || marketUnit(s.inventoryToken) !== marketUnit(pool.inventoryToken) || listing.seller !== pool.utxo.address || listing.sellerKey !== pool.batcher || marketUnit(listing.priceAsset) !== marketUnit(pool.quote)) throw new Error("Inventory listing does not belong to this pool.");
  if (pool.cost < s.cost || pool.inventory < listing.price || pool.count <= BigInt(0)) throw new Error("Inventory accounting cannot be reconciled.");
  return s;
}
export type MarketAction = { kind: "buy"; listing: MarketListing } | { kind: "cancel"; listing: MarketListing } | { kind: "update"; listing: MarketListing; price: bigint } | { kind: "reprice"; listing: MarketListing; price: bigint } | { kind: "acquire"; listing: MarketListing } | { kind: "deposit"; amount: bigint } | { kind: "topup"; amount: bigint } | { kind: "withdraw"; burned: bigint; acceptZero: boolean } | { kind: "return"; listing: MarketListing } | { kind: "complete" } | { kind: "prices"; prices: PoolPrice[] } | { kind: "configure"; minimum: bigint; paused: boolean };

// One reviewed builder is used by the UI and compiled-validator emulator tests.
// Caller authenticates deployment, refreshes inputs, and checks the wallet again before signing.
export function buildMarketAction(lucid: LucidEvolution, tools: Tools, scripts: MarketScripts, owner: string, action: MarketAction, pool?: SharedPool) {
  const c = (index: number, fields: Data[] = []) => new tools.Constr(index, fields);
  const data = (value: Data) => tools.Data.to(value);
  const signer = keyOf(tools, owner), address = marketAddressData(tools, owner);
  let tx = lucid.newTx();
  const referenced = (script: Script) => (scripts.references || []).some((utxo) => utxo.scriptRef && tools.validatorToScriptHash(utxo.scriptRef) === tools.validatorToScriptHash(script));
  const references = (scripts.references || []).filter((utxo) => utxo.scriptRef && [scripts.orderbook, scripts.pool, scripts.lp, scripts.inventory].some((script) => tools.validatorToScriptHash(script) === tools.validatorToScriptHash(utxo.scriptRef!)));
  if (references.length) tx = tx.readFrom(references);
  const spend = (script: Script) => { if (!referenced(script)) tx = tx.attach.SpendingValidator(script); };
  const policy = (script: Script) => { if (!referenced(script)) tx = tx.attach.MintingPolicy(script); };
  const consumeListing = (listing: MarketListing, redeemer: Node) => { if (listing.utxo.address !== scripts.orderbookAddress) throw new Error("Listing address does not match this deployment."); tx = tx.collectFrom([listing.utxo], data(redeemer)); spend(scripts.orderbook); };
  const continuePool = (state: SharedPool, redeemer: Node, next: Node, assets = state.utxo.assets) => { if (state.utxo.address !== scripts.poolAddress) throw new Error("Pool address mismatch."); tx = tx.collectFrom([state.utxo], data(redeemer)).pay.ToContract(state.utxo.address, { kind: "inline", value: data(next) }, assets); spend(scripts.pool); };
  const receipt = (state: SharedPool, amount: bigint) => { tx = tx.mintAssets({ [marketUnit(state.inventoryToken)]: amount }, data(c(amount > BigInt(0) ? 0 : 1))); policy(scripts.inventory); };
  const mintLp = (state: SharedPool, amount: bigint) => { tx = tx.mintAssets({ [state.lpUnit]: amount }, data(c(amount > BigInt(0) ? 0 : 1))); policy(scripts.lp); };
  if (action.kind === "cancel" || action.kind === "update") {
    const listing = action.listing;
    if (listing.sellerKey !== signer || listing.settlement.kind === "pool") throw new Error("Only the seller may edit/cancel non-pool listings.");
    if (action.kind === "cancel") { consumeListing(listing, c(1)); tx = tx.pay.ToAddress(listing.seller, listing.utxo.assets); }
    else { if (action.price <= BigInt(0)) throw new Error("Price must be positive."); const next = listingDatum(tools, { ...listing, price: action.price }); consumeListing(listing, c(2, [next])); tx = tx.pay.ToContract(listing.utxo.address, { kind: "inline", value: data(next) }, listing.utxo.assets); }
    return tx.addSigner(owner);
  }
  if (action.kind === "buy" && action.listing.settlement.kind === "direct") {
    const listing = action.listing;
    consumeListing(listing, c(0, [address]));
    return tx.pay.ToAddress(listing.seller, delta({ lovelace: listing.lockedLovelace }, marketUnit(listing.priceAsset), listing.price)).pay.ToAddress(owner, { [marketUnit(listing.rwa)]: listing.quantity });
  }
  if (!pool) throw new Error("An authenticated current pool is required.");
  const unit = marketUnit(pool.quote);
  if (action.kind === "buy") {
    const listing = action.listing, settlement = bound(listing, pool);
    if (pool.paused || pool.closing) throw new Error("Pool trading is paused or closing.");
    const next = nextPool(tools, pool, { cost: pool.cost - settlement.cost, inventory: pool.inventory - listing.price, count: pool.count - BigInt(1) });
    consumeListing(listing, c(0, [address])); receipt(pool, -BigInt(1));
    continuePool(pool, c(7, [address, next]), next, delta(delta(pool.utxo.assets, unit, listing.price), "lovelace", listing.lockedLovelace));
    return tx.pay.ToAddress(owner, { [marketUnit(listing.rwa)]: listing.quantity });
  }
  if (action.kind === "acquire") {
    const listing = action.listing;
    if (signer !== pool.batcher || listing.settlement.kind !== "instant" || marketUnit(listing.settlement.poolToken) !== marketUnit(pool.poolToken) || marketUnit(listing.priceAsset) !== unit) throw new Error("Only this pool's batcher can acquire its Instant Sell listings.");
    const { bid, ask } = postedQuote(pool, marketUnit(listing.rwa), listing.quantity);
    if (bid < listing.price) throw new Error("Posted buy price is below the seller minimum.");
    const inventory = listingDatum(tools, { ...listing, seller: pool.utxo.address, sellerKey: pool.batcher, settlement: { kind: "pool", poolToken: pool.poolToken, inventoryToken: pool.inventoryToken, cost: bid }, price: ask });
    const next = nextPool(tools, pool, { cost: pool.cost + bid, inventory: pool.inventory + ask, count: pool.count + BigInt(1) });
    consumeListing(listing, c(3, [inventory])); receipt(pool, BigInt(1)); continuePool(pool, c(6, [inventory, next]), next, delta(pool.utxo.assets, unit, -bid));
    // Operator funds the new inventory output's minimum ADA; pool cash falls by the bid only.
    return tx.pay.ToAddress(listing.seller, delta({ lovelace: listing.lockedLovelace }, unit, bid)).pay.ToContract(scripts.orderbookAddress, { kind: "inline", value: data(inventory) }, { lovelace: listing.lockedLovelace, [marketUnit(listing.rwa)]: listing.quantity, [marketUnit(pool.inventoryToken)]: BigInt(1) }).addSigner(owner);
  }
  if (action.kind === "reprice") {
    bound(action.listing, pool);
    if (signer !== pool.batcher || pool.paused || pool.closing || action.price <= BigInt(0)) throw new Error("Repricing requires the batcher, a live pool and a positive ask.");
    const nextListing = listingDatum(tools, { ...action.listing, price: action.price });
    const next = nextPool(tools, pool, { inventory: pool.inventory - action.listing.price + action.price });
    consumeListing(action.listing, c(4, [nextListing])); continuePool(pool, c(8, [nextListing, next]), next);
    return tx.pay.ToContract(scripts.orderbookAddress, { kind: "inline", value: data(nextListing) }, action.listing.utxo.assets).addSigner(owner);
  }
  if (action.kind === "deposit" || action.kind === "topup") {
    if (pool.closing || action.amount <= BigInt(0)) throw new Error("Top-ups and deposits require a non-closing pool and positive amount.");
    const minted = action.kind === "deposit" ? lpDeposit(pool, action.amount) : BigInt(0);
    const next = nextPool(tools, pool, { supply: pool.supply + minted });
    continuePool(pool, action.kind === "deposit" ? c(0, [action.amount, minted, address, signer, next]) : c(1, [action.amount, next]), next, delta(pool.utxo.assets, unit, action.amount));
    if (minted > BigInt(0)) { mintLp(pool, minted); tx = tx.pay.ToAddress(owner, { [pool.lpUnit]: minted }).addSigner(owner); }
    return tx;
  }
  if (action.kind === "withdraw") {
    const quote = lpWithdrawal(pool, action.burned);
    if (quote.amount === BigInt(0) && !action.acceptZero) throw new Error("Explicitly confirm burning LP shares for zero cash.");
    if (quote.final && !scripts.identity) throw new Error("Final exit disabled: this deployment has no reviewed burn-capable identity policy. The legacy one_shot policy cannot complete closure.");
    const next = nextPool(tools, pool, { supply: pool.supply - action.burned, closing: quote.final ? { recipient: owner, key: signer } : null });
    continuePool(pool, quote.final ? c(3, [quote.amount, address, signer, next]) : c(2, [quote.amount, action.burned, address, signer, next]), next, delta(pool.utxo.assets, unit, -quote.amount)); mintLp(pool, -action.burned);
    if (quote.amount > BigInt(0)) tx = tx.pay.ToAddress(owner, { [unit]: quote.amount });
    return tx.addSigner(owner);
  }
  if (action.kind === "return") {
    const s = bound(action.listing, pool), exit = pool.closing;
    if (!exit || signer !== exit.key) throw new Error("Only the recorded exiting LP can return inventory.");
    const next = nextPool(tools, pool, { cost: pool.cost - s.cost, inventory: pool.inventory - action.listing.price, count: pool.count - BigInt(1) });
    consumeListing(action.listing, c(5, [marketAddressData(tools, exit.recipient), exit.key, next])); receipt(pool, -BigInt(1)); continuePool(pool, c(4, [action.listing.raw, next]), next);
    const assets = { ...action.listing.utxo.assets }; delete assets[marketUnit(pool.inventoryToken)];
    return tx.pay.ToAddress(exit.recipient, assets).addSigner(owner);
  }
  if (action.kind === "complete") {
    if (!pool.closing || signer !== pool.closing.key || pool.supply || pool.cost || pool.inventory || pool.count) throw new Error("Complete exit requires the recorded LP and zero shares/inventory accounting.");
    if (!scripts.identity || tools.mintingPolicyToId(scripts.identity.script) !== pool.poolToken.policyId) throw new Error("No reviewed burn-capable identity policy is configured. Legacy one_shot identities cannot burn.");
    const assets = { ...pool.utxo.assets }; delete assets[marketUnit(pool.poolToken)];
    spend(scripts.pool);
    return tx.collectFrom([pool.utxo], data(c(5))).mintAssets({ [marketUnit(pool.poolToken)]: -BigInt(1) }, scripts.identity.redeemer).attach.MintingPolicy(scripts.identity.script).pay.ToAddress(pool.closing.recipient, assets).addSigner(owner);
  }
  if (pool.closing) throw new Error("Configuration changes are disabled during exit.");
  if (action.kind === "prices") {
    if (signer !== pool.batcher) throw new Error("Only the batcher can post prices.");
    const next = nextPool(tools, pool, { prices: action.prices });
    decodeSharedPool(tools, { ...pool.utxo, datum: data(next) });
    continuePool(pool, c(9, [next]), next);
  } else {
    if (signer !== pool.admin || action.minimum < BigInt(0)) throw new Error("Only the administrator can update pool controls.");
    const next = nextPool(tools, pool, { minimum: action.minimum, paused: action.paused });
    continuePool(pool, c(10, [next]), next);
  }
  return tx.addSigner(owner);
}
