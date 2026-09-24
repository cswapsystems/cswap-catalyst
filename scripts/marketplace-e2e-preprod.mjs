// End-to-end Marketplace acceptance on Preprod with the local demo wallets.
// Deploys an isolated pool identity from the current blueprint (the committed
// deployment manifest is never modified), exercises every user/operator flow,
// replays the reviewed attacks (each must be rejected by local evaluation AND
// by the node's evaluator via Blockfrost), then winds the pool down and cleans
// up its listings and reference scripts.
//
//   node --experimental-strip-types scripts/marketplace-e2e-preprod.mjs
//
// Progress is journaled to test-results/ so an interrupted run resumes.
import { readFile } from 'node:fs/promises';
import { buildMarketAction, decodeMarketListing, decodeSharedPool, listingDatum, lpWithdrawal, marketAddressData, marketUnit, nextPool } from '../src/lib/marketplace.ts';
import { assertDeployment, bootstrapBuilder, deploymentScripts, referenceNames, referenceOutput } from './lib/marketplace-deployment.mjs';
import { preprodHarness, ROLES, ROOT } from './lib/preprod-harness.mjs';

const FUND = 300_000_000n, LOCKED = 3_000_000n, QTY = 10n;
const h = await preprodHarness('marketplace-e2e-preprod', {
  watched: (lucid, journal) => journal.deployment ? [lucid.utxoByUnit(journal.deployment.pool.token).then(u => (u ? [u] : []), () => []), lucid.utxosAt(journal.deployment.orderbookAddress)] : [],
});
const { t, lucid, wallets, as, journal, save, submit, step, attack, balance } = h;
const [admin, seller, buyer, attacker] = ROLES.map(role => wallets[role]);
const c = (index, fields = []) => new t.Constr(index, fields);
const data = value => t.Data.to(value);

const blueprint = JSON.parse(await readFile(new URL('contracts/marketplace/plutus.json', ROOT), 'utf8'));
const code = Object.fromEntries(blueprint.validators.map(v => [v.title, v.compiledCode]));
const manifest = JSON.parse(await readFile(new URL('marketplace-deployment.preprod.json', ROOT), 'utf8'));

// ---- Funding and test assets -------------------------------------------------
await step('fund demo wallets', async () => {
  as('team');
  let builder = lucid.newTx();
  for (const role of ROLES) builder = builder.pay.ToAddress(wallets[role].address, { lovelace: FUND });
  return submit('team', () => builder);
});
const assetPolicy = t.scriptFromNative({ type: 'sig', keyHash: seller.key });
const FT = t.mintingPolicyToId(assetPolicy) + t.fromText('E2E_FT'), EXTRA = t.mintingPolicyToId(assetPolicy) + t.fromText('E2E_X');
await step('mint test tokens', () => submit('custody', () => lucid.newTx().mintAssets({ [FT]: 1_000n, [EXTRA]: 10n }).attach.MintingPolicy(assetPolicy).pay.ToAddress(seller.address, { [FT]: 1_000n, [EXTRA]: 10n })));
await step('distribute buyer tokens', () => submit('custody', () => lucid.newTx().pay.ToAddress(buyer.address, { lovelace: 2_000_000n, [FT]: 50n })));

// ---- Isolated deployment ------------------------------------------------------
if (!journal.deployment) {
  as('admin');
  const seed = (await lucid.wallet().getUtxos()).find(u => !u.scriptRef && Object.keys(u.assets).length === 1 && u.assets.lovelace >= 50_000_000n);
  const name = t.fromText('CSWAP_E2E_POOL'), lpName = t.fromText('CSWAP_E2E_LP'), inventoryName = t.fromText('CSWAP_E2E_INV');
  const identity = { type: 'PlutusV3', script: t.applyParamsToScript(code['one_shot.one_shot.mint'], [c(0, [seed.txHash, BigInt(seed.outputIndex)]), name]) };
  const deployment = {
    schemaVersion: 14, network: 'preprod', team: admin.key, batcher: admin.key, registry: { ...manifest.registry },
    pool: { token: t.mintingPolicyToId(identity) + name, identitySeed: { txHash: seed.txHash, outputIndex: seed.outputIndex }, lpToken: '0'.repeat(56) + lpName, inventoryToken: '0'.repeat(56) + inventoryName, quoteUnit: 'lovelace', minCashReserve: '10000000' },
  };
  const derived = deploymentScripts(code, deployment);
  deployment.orderbookAddress = derived.orderbookAddress;
  deployment.pool.address = derived.poolAddress;
  deployment.pool.lpToken = t.mintingPolicyToId(derived.lp) + lpName;
  deployment.pool.inventoryToken = t.mintingPolicyToId(derived.inventory) + inventoryName;
  const custody = t.scriptFromNative({ type: 'sig', keyHash: admin.key });
  deployment.referenceCustody = { address: t.validatorToAddress('Preprod', custody), script: custody };
  journal.deployment = deployment;
  journal.steps['bootstrap pool'] = await submit('admin', () => bootstrapBuilder(lucid, deployment, identity, seed));
  await save();
  console.log('✓ bootstrap pool', journal.steps['bootstrap pool']);
}
const deployment = journal.deployment;
// One transaction per script: together they exceed the 16 KiB size limit.
for (const name of referenceNames) await step(`publish reference script: ${name}`, () => submit('admin', () => {
  const output = referenceOutput(lucid, deployment, deploymentScripts(code, deployment)[name]);
  return lucid.newTx().pay.ToAddressWithData(output.address, { kind: 'inline', value: output.datum }, output.assets, output.scriptRef);
}));
const references = (await lucid.utxosAt(deployment.referenceCustody.address)).filter(u => u.scriptRef);
const verified = assertDeployment(code, deployment, await lucid.utxoByUnit(deployment.pool.token), references);
const scripts = verified.scripts;
if (!scripts.identity) throw new Error('Burn-capable pool identity did not verify.');

const readPool = async () => decodeSharedPool(t, await lucid.utxoByUnit(deployment.pool.token));
async function listings() {
  const found = [];
  for (const utxo of await lucid.utxosAt(scripts.orderbookAddress)) {
    try { const listing = decodeMarketListing(t, utxo); if (marketUnit(listing.rwa) === FT) found.push(listing); } catch { /* other deployments / malformed */ }
  }
  return found;
}
const listingAt = async price => {
  const listing = (await listings()).find(item => item.price === price);
  if (!listing) throw new Error(`No test listing priced ${price}.`);
  return listing;
};
const act = (role, action) => submit(role, async () => buildMarketAction(lucid, t, scripts, wallets[role].address, action, await readPool()));
const list = async (kind, price, extra = {}) => {
  const listing = { seller: seller.address, sellerKey: seller.key, settlement: kind === 'direct' ? { kind } : { kind, poolToken: (await readPool()).poolToken }, rwa: { policyId: FT.slice(0, 56), assetName: FT.slice(56) }, quantity: QTY, priceAsset: { policyId: '', assetName: '' }, price };
  as('custody');
  return submit('custody', () => lucid.newTx().pay.ToContract(scripts.orderbookAddress, { kind: 'inline', value: data(listingDatum(t, listing)) }, { lovelace: LOCKED, [FT]: QTY, ...extra }));
};

// ---- Direct listings ------------------------------------------------------------
await step('direct: list', () => list('direct', 5_000_001n));
await step('direct: update price', async () => act('custody', { kind: 'update', listing: await listingAt(5_000_001n), price: 5_000_002n }));
await step('direct: buy (tagged seller payment)', async () => {
  const listing = await listingAt(5_000_002n), before = await balance(buyer.address, FT);
  const hash = await act('treasury', { kind: 'buy', listing });
  if (await balance(buyer.address, FT) !== before + QTY) throw new Error('Buyer did not receive the RWA.');
  const tx = await (await fetch(`https://cardano-preprod.blockfrost.io/api/v0/txs/${hash}/utxos`, { headers: { project_id: process.env.BLOCKFROST_PROJECT_ID } })).json();
  const paid = tx.outputs.find(o => o.address === seller.address && o.inline_datum);
  if (!paid || paid.inline_datum !== data(c(0, [listing.utxo.txHash, BigInt(listing.utxo.outputIndex)]))) throw new Error('Seller payment is not tagged with the listing reference.');
  return hash;
});
await step('direct: list for cancel', () => list('direct', 5_000_003n));
await step('direct: cancel', async () => act('custody', { kind: 'cancel', listing: await listingAt(5_000_003n) }));
await step('direct: list with unlisted extra assets', () => list('direct', 5_000_004n, { lovelace: LOCKED + 4_000_000n, [EXTRA]: 3n }));
await step('direct: cancel returns whole escrow', async () => {
  const utxo = (await lucid.utxosAt(scripts.orderbookAddress)).find(u => u.assets[EXTRA] === 3n);
  if (!utxo) throw new Error('Extra-asset listing not found.');
  const before = await balance(seller.address, EXTRA);
  as('custody');
  const hash = await submit('custody', () => lucid.newTx().readFrom(references).collectFrom([utxo], data(c(1))).pay.ToAddress(seller.address, utxo.assets).addSigner(seller.address));
  if (await balance(seller.address, EXTRA) !== before + 3n) throw new Error('Extra asset was not returned.');
  return hash;
});

// ---- Shared pool: liquidity, prices, Instant Sell, inventory --------------------
await step('pool: admin deposit', () => act('admin', { kind: 'deposit', amount: 60_000_000n }));
await step('pool: second LP deposit', () => act('treasury', { kind: 'deposit', amount: 30_000_000n }));
await step('pool: top-up', () => act('custody', { kind: 'topup', amount: 1_000_000n }));
const prices = [{ asset: { policyId: FT.slice(0, 56), assetName: FT.slice(56) }, buy: { numerator: 1_000_000n, denominator: 1n }, sell: { numerator: 1_500_000n, denominator: 1n } }];
await step('pool: batcher posts prices', () => act('admin', { kind: 'prices', prices }));
await step('pool: configure reserve', () => act('admin', { kind: 'configure', minimum: 10_000_000n, paused: false }));
await step('instant sell: request A', () => list('instant', 8_000_001n));
await step('instant sell: batcher acquires A', async () => {
  const hash = await act('admin', { kind: 'acquire', listing: await listingAt(8_000_001n) });
  const pool = await readPool();
  if (pool.count !== 1n || pool.cost !== 10_000_000n || pool.inventory !== 15_000_000n) throw new Error('Pool accounting after acquisition is wrong.');
  return hash;
});
await step('inventory: batcher reprices A', async () => act('admin', { kind: 'reprice', listing: await listingAt(15_000_000n), price: 14_000_001n }));
await step('inventory: buyer purchases A', async () => {
  const cash = (await readPool()).cash, before = await balance(buyer.address, FT);
  const hash = await act('treasury', { kind: 'buy', listing: await listingAt(14_000_001n) });
  const pool = await readPool();
  if (pool.count !== 0n || pool.cost !== 0n || pool.inventory !== 0n || pool.cash !== cash + 14_000_001n + LOCKED) throw new Error('Pool accounting after inventory sale is wrong.'); // price plus the listing's returned deposit
  if (await balance(buyer.address, FT) !== before + QTY) throw new Error('Buyer did not receive pool inventory.');
  return hash;
});
await step('instant sell: request B', () => list('instant', 8_000_002n));
await step('instant sell: batcher acquires B', async () => act('admin', { kind: 'acquire', listing: await listingAt(8_000_002n) }));
await step('instant sell: request C', () => list('instant', 8_000_003n));
await step('instant sell: batcher acquires C', async () => act('admin', { kind: 'acquire', listing: await listingAt(8_000_003n) }));
await step('instant sell: seller cancels unfilled request', async () => { await list('instant', 8_000_004n); return act('custody', { kind: 'cancel', listing: await listingAt(8_000_004n) }); });
await step('pool: partial LP withdrawal', async () => {
  const lp = await balance(buyer.address, (await readPool()).lpUnit);
  return act('treasury', { kind: 'withdraw', burned: lp / 2n, acceptZero: false });
});

// ---- Attacks: each must be rejected by the validators ---------------------------
const inventory = async () => (await listings()).filter(item => item.settlement.kind === 'pool');
await attack('pool inventory taken via 1-lovelace AddFunds', 'settlement', async () => {
  const pool = await readPool(), [target] = await inventory(), next = nextPool(t, pool, {});
  return lucid.newTx().readFrom(references)
    .collectFrom([pool.utxo], data(c(1, [1n, next])))
    .collectFrom([target.utxo], data(c(0, [marketAddressData(t, attacker.address)])))
    .pay.ToContract(pool.utxo.address, { kind: 'inline', value: data(next) }, { ...pool.utxo.assets, lovelace: pool.utxo.assets.lovelace + 1n })
    .pay.ToAddress(attacker.address, target.utxo.assets);
});
await attack('second inventory listing piggybacks on a paid sale', 'settlement', async () => {
  const pool = await readPool(), [first, second] = await inventory();
  return buildMarketAction(lucid, t, scripts, attacker.address, { kind: 'buy', listing: first }, pool)
    .collectFrom([second.utxo], data(c(0, [marketAddressData(t, attacker.address)])))
    .pay.ToAddress(attacker.address, second.utxo.assets);
});
await step('attack setup: two identical direct listings', async () => { await list('direct', 6_000_000n); return list('direct', 6_000_000n); });
await attack('one payment buys two direct listings', 'settlement', async () => {
  const [first, second] = (await listings()).filter(item => item.price === 6_000_000n);
  const tag = data(c(0, [first.utxo.txHash, BigInt(first.utxo.outputIndex)]));
  return lucid.newTx().readFrom(references)
    .collectFrom([first.utxo, second.utxo], data(c(0, [marketAddressData(t, attacker.address)])))
    .pay.ToAddressWithData(seller.address, { kind: 'inline', value: tag }, { lovelace: 6_000_000n + LOCKED })
    .pay.ToAddress(attacker.address, { [FT]: 2n * QTY });
});
await attack('direct purchase with untagged payment', 'settlement', async () => {
  const [first] = (await listings()).filter(item => item.price === 6_000_000n);
  return lucid.newTx().readFrom(references)
    .collectFrom([first.utxo], data(c(0, [marketAddressData(t, attacker.address)])))
    .pay.ToAddress(seller.address, { lovelace: 6_000_000n + LOCKED })
    .pay.ToAddress(attacker.address, { [FT]: QTY });
});
await attack('non-seller cancels a listing', 'settlement', async () => {
  const [first] = (await listings()).filter(item => item.price === 6_000_000n);
  return lucid.newTx().readFrom(references).collectFrom([first.utxo], data(c(1))).pay.ToAddress(seller.address, first.utxo.assets).addSigner(attacker.address);
});
await step('attack setup: two identical Instant Sell requests', async () => { await list('instant', 7_000_000n); return list('instant', 7_000_000n); });
await attack('batcher acquires two identical requests with one payout', 'admin', async () => {
  const pool = await readPool(), [first, second] = (await listings()).filter(item => item.price === 7_000_000n);
  const bid = QTY * 1_000_000n;
  const inventoryDatum = listingDatum(t, { ...first, seller: pool.utxo.address, sellerKey: pool.batcher, settlement: { kind: 'pool', poolToken: pool.poolToken, inventoryToken: pool.inventoryToken, cost: bid }, price: QTY * 1_500_000n });
  return buildMarketAction(lucid, t, scripts, admin.address, { kind: 'acquire', listing: first }, pool)
    .collectFrom([second.utxo], data(c(3, [inventoryDatum])))
    .pay.ToAddress(admin.address, { [FT]: QTY });
});

// ---- Wind-down: LP exit, inventory return, identity burn, cleanup ---------------
await step('cleanup: seller cancels attack listings', async () => {
  let last;
  for (const listing of (await listings()).filter(item => item.settlement.kind !== 'pool')) last = await act('custody', { kind: 'cancel', listing });
  return last;
});
await step('exit: second LP withdraws remaining shares', async () => act('treasury', { kind: 'withdraw', burned: await balance(buyer.address, (await readPool()).lpUnit), acceptZero: true }));
await step('exit: final LP starts exit', async () => {
  const pool = await readPool(), burned = await balance(admin.address, pool.lpUnit);
  if (burned !== pool.supply || !lpWithdrawal(pool, burned).final) throw new Error('Admin should hold the whole remaining LP supply.');
  const hash = await act('admin', { kind: 'withdraw', burned, acceptZero: true });
  if ((await readPool()).closing?.recipient !== admin.address) throw new Error('Pool is not closing to the admin.');
  return hash;
});
await step('exit: return remaining inventory', async () => {
  let last;
  for (const listing of await inventory()) last = await act('admin', { kind: 'return', listing });
  const pool = await readPool();
  if (pool.count || pool.cost || pool.inventory) throw new Error('Inventory accounting did not reach zero.');
  return last;
});
await step('exit: complete and burn pool identity', async () => {
  const hash = await act('admin', { kind: 'complete' });
  if (await lucid.utxoByUnit(deployment.pool.token).then(Boolean, () => false)) throw new Error('Pool identity still exists.');
  return hash;
});
await step('cleanup: reclaim reference scripts', async () => {
  const refs = (await lucid.utxosAt(deployment.referenceCustody.address)).filter(u => u.scriptRef);
  as('admin');
  return submit('admin', () => lucid.newTx().collectFrom(refs).attach.SpendingValidator(deployment.referenceCustody.script).addSigner(admin.address));
});
if ((await listings()).length) throw new Error('Test listings remain at the orderbook address.');

h.summary();
