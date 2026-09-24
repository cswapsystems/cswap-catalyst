import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as t from '@lucid-evolution/lucid';
import { buildMarketAction, decodeSharedPool, decodeMarketListing, decodeSettlement, listingDatum, nextPool, marketAddressData, marketAssetData, marketUnit, postedQuote, lpDeposit, lpWithdrawal } from '../src/lib/marketplace.ts';

const blueprint = JSON.parse(await readFile(new URL('../contracts/marketplace/plutus.json', import.meta.url), 'utf8'));
const script = (title, params = []) => { const code = blueprint.validators.find(v => v.title === title).compiledCode; return { type: 'PlutusV3', script: params.length ? t.applyParamsToScript(code, params) : code }; };
const a = unit => unit === 'lovelace' ? { policyId: '', assetName: '' } : { policyId: unit.slice(0, 56), assetName: unit.slice(56) };
const key = address => t.getAddressDetails(address).paymentCredential.hash;
const c = (fields, index = 0) => new t.Constr(index, fields);
const ft = 'ab'.repeat(28) + '01', tokenQuote = 'cd'.repeat(28) + '02';

async function fixture(quote = 'lovelace') {
  const operator = t.generateEmulatorAccount({ lovelace: 2_000_000_000n, [ft]: 1000n, [tokenQuote]: 1_000_000_000n });
  const seller = t.generateEmulatorAccount({ lovelace: 1_000_000_000n, [ft]: 1000n, [tokenQuote]: 1_000_000_000n });
  const outsider = t.generateEmulatorAccount({ lovelace: 1_000_000_000n });
  const emulator = new t.Emulator([operator, seller, outsider]);
  const lucid = await t.Lucid(emulator, 'Preprod');
  const select = who => lucid.selectWallet.fromSeed(who.seedPhrase);
  const submit = async builder => { const hash = await (await (await builder.complete()).sign.withWallet().complete()).submit(); emulator.awaitBlock(1); return hash; };
  select(operator);
  // Test-only burn-capable identity. The supplied production one_shot has no burn path.
  const identity = t.scriptFromNative({ type: 'any', scripts: [{ type: 'sig', keyHash: key(operator.address) }, { type: 'sig', keyHash: key(seller.address) }] });
  const poolToken = a(t.mintingPolicyToId(identity) + t.fromText('POOL'));
  const orderbook = script('p2p_listing_simple.p2p_listing_simple.spend');
  const orderbookAddress = t.validatorToAddress('Preprod', orderbook);
  const pool = script('quote_pool.quote_pool.spend', [marketAddressData(t, orderbookAddress)]);
  const poolAddress = t.validatorToAddress('Preprod', pool);
  const lp = script('lp_policy.lp_policy.mint', [marketAssetData(t, poolToken), t.fromText('LP')]);
  const inventory = script('inventory_policy.inventory_policy.mint', [marketAssetData(t, poolToken), t.fromText('INVENTORY'), key(operator.address)]);
  const lpToken = a(t.mintingPolicyToId(lp) + t.fromText('LP')), inventoryToken = a(t.mintingPolicyToId(inventory) + t.fromText('INVENTORY'));
  const prices = [{ asset: a(ft), buy: { numerator: 1_000_000n, denominator: 3n }, sell: { numerator: 2_000_000n, denominator: 3n } }];
  const datum = c([key(operator.address), key(operator.address), marketAssetData(t, poolToken), marketAssetData(t, lpToken), marketAssetData(t, inventoryToken), marketAssetData(t, a(quote)), prices.map(p => c([marketAssetData(t, p.asset), c([p.buy.numerator, p.buy.denominator]), c([p.sell.numerator, p.sell.denominator])])), 0n, 10_000_000n, c([]), 0n, 0n, 0n, c([], 1)]);
  await submit(lucid.newTx().mintAssets({ [marketUnit(poolToken)]: 1n }).attach.MintingPolicy(identity).pay.ToContract(poolAddress, { kind: 'inline', value: t.Data.to(datum) }, { lovelace: quote === 'lovelace' ? 20_000_000n : 5_000_000n, ...(quote === 'lovelace' ? {} : { [quote]: 20_000_000n }), [marketUnit(poolToken)]: 1n }));
  // Keep real ledger transaction-size/execution limits: use reference scripts.
  for (const reference of [orderbook, pool, lp, inventory]) await submit(lucid.newTx().pay.ToAddressWithData(operator.address, { kind: 'inline', value: t.Data.to(0n) }, { lovelace: 80_000_000n }, reference));
  const references = (await lucid.utxosAt(operator.address)).filter(u => u.scriptRef);
  const scripts = { orderbook, pool, lp, inventory, orderbookAddress, poolAddress, references, identity: { script: identity, redeemer: t.Data.to(c([])) } };
  const readPool = async () => decodeSharedPool(t, await lucid.utxoByUnit(marketUnit(poolToken)));
  const listings = async () => (await lucid.utxosAt(orderbookAddress)).filter(u => u.datum).map(u => decodeMarketListing(t, u));
  const act = async (who, action) => { select(who); return submit(buildMarketAction(lucid, t, scripts, who.address, action, await readPool())); };
  const create = async (kind = 'instant') => {
    select(seller);
    const qty = 3n;
    const listing = { seller: seller.address, sellerKey: key(seller.address), settlement: kind === 'direct' ? { kind } : { kind, poolToken }, rwa: a(ft), quantity: qty, priceAsset: a(quote), price: 1_000_000n };
    await submit(lucid.newTx().pay.ToContract(orderbookAddress, { kind: 'inline', value: t.Data.to(listingDatum(t, listing)) }, { lovelace: 3_000_000n, [ft]: qty }));
    return (await listings()).find(l => l.settlement.kind === kind);
  };
  return { lucid, emulator, operator, seller, outsider, scripts, select, submit, readPool, listings, act, create, prices, poolToken, lpToken, quote };
}

test('settlement constructors are strict: InstantSell is 1, inventory is 2', () => {
  const token = marketAssetData(t, a(ft));
  assert.equal(decodeSettlement(c([])).kind, 'direct');
  assert.equal(decodeSettlement(c([token], 1)).kind, 'instant');
  assert.equal(decodeSettlement(c([token, token, 5n], 2)).cost, 5n);
  for (const value of [c([token, token], 1), c([token, token], 2), c([], 3), c([token])]) assert.throws(() => decodeSettlement(value));
});

test('shared pool strict decoding and integer LP/price arithmetic', async () => {
  const f = await fixture(), pool = await f.readPool();
  assert.equal(pool.raw.fields.length, 14);
  assert.equal(postedQuote(pool, ft, 1n).bid, 333_333n);
  assert.equal(lpDeposit(pool, 10_000_000n), 30_000_000n); // initial equity is included
  assert.throws(() => decodeSharedPool(t, { ...pool.utxo, datum: t.Data.to(c(pool.raw.fields.slice(0, 10))) }), /Legacy/);
  const bad = [...pool.raw.fields]; bad[13] = c([], 0);
  assert.throws(() => decodeSharedPool(t, { ...pool.utxo, datum: t.Data.to(c(bad)) }));
  assert.throws(() => postedQuote({ ...pool, paused: true }, ft, 1n), /paused/);
});

for (const quote of ['lovelace', tokenQuote]) test('compiled Marketplace lifecycle with ' + (quote === 'lovelace' ? 'ADA' : 'native quote'), async () => {
  const f = await fixture(quote);
  await f.act(f.operator, { kind: 'deposit', amount: 50_000_000n });
  let pool = await f.readPool(); assert.equal(pool.supply, 70_000_000n);
  const direct = await f.create('direct');
  await f.act(f.seller, { kind: 'update', listing: direct, price: 2_000_000n });
  await f.act(f.operator, { kind: 'buy', listing: (await f.listings())[0] });
  const cancelled = await f.create();
  await f.act(f.seller, { kind: 'update', listing: cancelled, price: 900_000n });
  await f.act(f.seller, { kind: 'cancel', listing: (await f.listings())[0] });
  const request = await f.create();
  assert.throws(() => buildMarketAction(f.lucid, t, f.scripts, f.outsider.address, { kind: 'acquire', listing: request }, pool), /batcher/);
  await f.act(f.operator, { kind: 'acquire', listing: request });
  pool = await f.readPool(); assert.equal(pool.cost, 1_000_000n); assert.equal(pool.inventory, 2_000_000n); assert.equal(pool.count, 1n);
  const oldSupply = pool.supply, equity = pool.cash + pool.cost;
  await f.act(f.operator, { kind: 'deposit', amount: 7_000_000n });
  assert.equal((await f.readPool()).supply, oldSupply + 7_000_000n * oldSupply / equity);
  await f.act(f.operator, { kind: 'withdraw', burned: 1_000_000n, acceptZero: false });
  let listing = (await f.listings())[0];
  await f.act(f.operator, { kind: 'reprice', listing, price: 4_000_000n });
  pool = await f.readPool(); assert.equal(pool.cost, 1_000_000n); assert.equal(pool.inventory, 4_000_000n);
  await f.act(f.seller, { kind: 'buy', listing: (await f.listings())[0] });
  pool = await f.readPool(); assert.equal(pool.count, 0n); assert.equal(pool.cost, 0n);
  await f.act(f.operator, { kind: 'prices', prices: f.prices });
  await f.act(f.operator, { kind: 'configure', minimum: pool.cash, paused: true });
  const zero = lpWithdrawal(await f.readPool(), 1n); assert.equal(zero.amount, 0n);
  f.select(f.operator);
  assert.throws(() => buildMarketAction(f.lucid, t, f.scripts, f.operator.address, { kind: 'withdraw', burned: 1n, acceptZero: false }, { ...pool, minimum: pool.cash }), /zero cash/);
  await f.act(f.operator, { kind: 'withdraw', burned: 1n, acceptZero: true });
  await f.act(f.seller, { kind: 'topup', amount: 1_000_000n });
  await f.act(f.operator, { kind: 'configure', minimum: 10_000_000n, paused: false });
  await f.act(f.operator, { kind: 'acquire', listing: await f.create() });
  pool = await f.readPool();
  assert.throws(() => buildMarketAction(f.lucid, t, { ...f.scripts, identity: undefined }, f.operator.address, { kind: 'withdraw', burned: pool.supply, acceptZero: true }, pool), /identity policy/);
  // The exiting LP is not the batcher: receipt burning must not require that role.
  f.select(f.operator);
  await f.submit(f.lucid.newTx().pay.ToAddress(f.seller.address, { [pool.lpUnit]: pool.supply }));
  await f.act(f.seller, { kind: 'withdraw', burned: pool.supply, acceptZero: true });
  pool = await f.readPool(); assert.equal(pool.supply, 0n); assert.equal(pool.closing.recipient, f.seller.address);
  await f.act(f.seller, { kind: 'return', listing: (await f.listings())[0] });
  await f.act(f.seller, { kind: 'complete' });
  assert.equal((await f.lucid.utxosAt(f.scripts.poolAddress)).length, 0);
});
test('compiled pool rejects unauthorized price updates and forged accounting', async () => {
  const f = await fixture(), pool = await f.readPool();
  for (const [who, changes] of [[f.outsider, { prices: [] }], [f.operator, { cost: 1n }]]) {
    f.select(who);
    const next = nextPool(t, pool, changes);
    const malicious = f.lucid.newTx().readFrom(f.scripts.references)
      .collectFrom([pool.utxo], t.Data.to(c([next], 9)))
      .pay.ToContract(f.scripts.poolAddress, { kind: 'inline', value: t.Data.to(next) }, pool.utxo.assets)
      .addSigner(who.address);
    await assert.rejects(async () => f.submit(malicious));
    assert.equal((await f.readPool()).utxo.txHash, pool.utxo.txHash);
  }
});

test('archived legacy sell requests remain cancellable by their seller', async () => {
  const archive = JSON.parse(await readFile(new URL('../contracts/marketplace/legacy-request-recovery.json', import.meta.url), 'utf8'));
  const seller = t.generateEmulatorAccount({ lovelace: 100_000_000n, [ft]: 5n });
  const emulator = new t.Emulator([seller]), lucid = await t.Lucid(emulator, 'Preprod');
  lucid.selectWallet.fromSeed(seller.seedPhrase);
  const submit = async builder => { await (await (await builder.complete()).sign.withWallet().complete()).submit(); emulator.awaitBlock(1); };
  const recovery = { type: 'PlutusV3', script: t.applyParamsToScript(archive.requestCode, [marketAddressData(t, archive.poolAddress)]) };
  const address = t.validatorToAddress('Preprod', recovery);
  const datum = c([marketAddressData(t, seller.address), key(seller.address), marketAssetData(t, a(archive.poolToken)), marketAssetData(t, a(ft)), 3n, marketAssetData(t, a('lovelace')), 1_000_000n]);
  await submit(lucid.newTx().pay.ToContract(address, { kind: 'inline', value: t.Data.to(datum) }, { lovelace: 3_000_000n, [ft]: 3n }));
  const [request] = await lucid.utxosAt(address);
  await submit(lucid.newTx().collectFrom([request], t.Data.to(c([], 1))).attach.SpendingValidator(recovery).pay.ToAddress(seller.address, request.assets).addSigner(seller.address));
  assert.equal((await lucid.utxosAt(address)).length, 0);
});
