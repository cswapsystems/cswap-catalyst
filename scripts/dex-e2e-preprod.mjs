// End-to-end DEX acceptance on Preprod with the local demo wallets.
// Deploys an isolated factory from the current blueprint (dex-deployment.preprod.json
// is never modified), runs admin pools, swaps and liquidity changes, three-party
// bootstraps for ADA and token quotes, offer cancellation (including a
// malformed escrow), replays attacks that must be rejected, then closes every pool.
//
//   node --experimental-strip-types scripts/dex-e2e-preprod.mjs
import { readFile } from 'node:fs/promises';
import { preprodHarness, ROOT } from './lib/preprod-harness.mjs';
import { addressData, assetData, assetUnit, decodePool, nextDatum, poolName, poolValue, reservePayout, integerSqrt } from '../src/lib/protocol/dex-client.ts';
import { quoteConstantProduct, quoteLiquidityDeposit, quoteLiquidityWithdrawal } from '../src/lib/dex.ts';
import { reviewBootstrapTransaction } from '../src/lib/bootstrap-review.ts';
import { decodeCardanoAddress } from '../src/lib/address-codec.ts';

let deployment;
const h = await preprodHarness('dex-e2e-preprod', {
  watched: lucid => deployment ? [lucid.utxosAt(deployment.ammAddress), lucid.utxosAt(deployment.bootstrapOfferAddress), lucid.utxosAt(deployment.factoryAddress)] : [],
});
const { t, lucid, wallets, as, journal, save, submit, settle, step, attack, balance } = h;
const { admin, custody: owner, treasury: provider, settlement: attacker } = wallets;
const c = (index, fields = []) => new t.Constr(index, fields);
const data = value => t.Data.to(value);
const asset = unit => unit === 'lovelace' ? { policyId: '', assetName: '' } : { policyId: unit.slice(0, 56), assetName: unit.slice(56) };

const blueprint = JSON.parse(await readFile(new URL('contracts/dex/plutus.json', ROOT), 'utf8'));
const code = Object.fromEntries(blueprint.validators.map(v => [v.title, v.compiledCode]));
const script = (title, params = []) => ({ type: 'PlutusV3', script: params.length ? t.applyParamsToScript(code[title], params) : code[title] });

// Test assets: the FT is the Marketplace suite's E2E_FT (custody's policy);
// the token quote stands in for USDCx.
const ftPolicy = t.scriptFromNative({ type: 'sig', keyHash: owner.key });
const FT = t.mintingPolicyToId(ftPolicy) + t.fromText('E2E_FT');
const usdPolicy = t.scriptFromNative({ type: 'sig', keyHash: provider.key });
const USD = t.mintingPolicyToId(usdPolicy) + t.fromText('E2E_USD');
await step('mint token quote', () => submit('treasury', () => lucid.newTx().mintAssets({ [USD]: 1_000_000_000n }).attach.MintingPolicy(usdPolicy).pay.ToAddress(provider.address, { [USD]: 1_000_000_000n })));
await step('fund admin and LP with FT', async () => {
  if (await balance(owner.address, FT) < 700n) throw new Error('Custody needs at least 700 E2E_FT; run the Marketplace suite first.');
  return submit('custody', () => lucid.newTx().pay.ToAddress(admin.address, { lovelace: 2_000_000n, [FT]: 200n }).pay.ToAddress(provider.address, { lovelace: 2_000_000n, [FT]: 100n }));
});

// ---- Isolated factory ------------------------------------------------------------
const offerScript = script('bootstrap_offer.bootstrap_offer.spend');
const offerAddress = t.validatorToAddress('Preprod', offerScript);
const factoryScript = script('factory_state.factory_state.spend', [admin.key, addressData(t, offerAddress)]);
const factoryAddress = t.validatorToAddress('Preprod', factoryScript);
if (!journal.deployment) {
  as('admin');
  const seed = (await lucid.wallet().getUtxos()).find(u => Object.keys(u.assets).length === 1 && u.assets.lovelace >= 20_000_000n);
  const name = t.fromText('CSWAP_E2E_FACTORY');
  const identity = script('factory_bootstrap.factory_bootstrap.mint', [c(0, [seed.txHash, BigInt(seed.outputIndex)]), addressData(t, factoryAddress), name]);
  const factoryToken = t.mintingPolicyToId(identity) + name;
  const amm = script('amm_pool.amm_pool.spend', [assetData(t, asset(factoryToken))]);
  const ammAddress = t.validatorToAddress('Preprod', amm);
  const lpPolicyId = t.mintingPolicyToId(script('lp_policy.lp_policy.mint', [assetData(t, asset(factoryToken)), addressData(t, ammAddress)]));
  const poolPolicyId = t.mintingPolicyToId(script('pool_factory.pool_factory.mint', [assetData(t, asset(factoryToken)), addressData(t, ammAddress), lpPolicyId]));
  journal.deployment = { network: 'preprod', admin: admin.key, factoryToken, factoryAddress, ammAddress, lpPolicyId, poolPolicyId, bootstrapOfferAddress: offerAddress };
  journal.steps['deploy factory'] = await submit('admin', () => lucid.newTx().collectFrom([seed])
    .mintAssets({ [factoryToken]: 1n }, data(c(0))).attach.MintingPolicy(identity)
    .pay.ToContract(factoryAddress, { kind: 'inline', value: data(c(0, [assetData(t, asset(factoryToken)), admin.key, poolPolicyId, 0n, c(0)])) }, { lovelace: 5_000_000n, [factoryToken]: 1n })
    .addSigner(admin.address));
  await save();
  console.log('✓ deploy factory', journal.steps['deploy factory']);
}
deployment = journal.deployment;
const factoryAsset = asset(deployment.factoryToken);
const amm = script('amm_pool.amm_pool.spend', [assetData(t, factoryAsset)]);
const lp = script('lp_policy.lp_policy.mint', [assetData(t, factoryAsset), addressData(t, deployment.ammAddress)]);
const poolPolicy = script('pool_factory.pool_factory.mint', [assetData(t, factoryAsset), addressData(t, deployment.ammAddress), deployment.lpPolicyId]);
if (deployment.factoryAddress !== factoryAddress || t.validatorToAddress('Preprod', amm) !== deployment.ammAddress || t.mintingPolicyToId(lp) !== deployment.lpPolicyId || t.mintingPolicyToId(poolPolicy) !== deployment.poolPolicyId) throw new Error('Journaled DEX deployment does not match the blueprint.');

const factory = async () => { const utxo = await lucid.utxoByUnit(deployment.factoryToken); return { utxo, fields: t.Data.from(utxo.datum).fields }; };
const pools = async () => (await lucid.utxosAt(deployment.ammAddress)).filter(u => u.datum).map(u => decodePool(t, u));
// Several pools can share a pair (admin pool, bootstrapped pool): pool IDs
// increase, so the admin pool is the oldest and a fresh bootstrap the newest.
const poolFor = async (quote, which = 'oldest') => {
  const found = (await pools()).filter(p => assetUnit(p.assetA) === quote && assetUnit(p.assetB) === FT).sort((x, y) => x.poolNft.assetName.localeCompare(y.poolNft.assetName));
  if (!found.length) throw new Error(`No ${quote}/FT pool.`);
  return which === 'newest' ? found.at(-1) : found[0];
};
const factoryAdvance = (builder, state, redeemer) => builder.collectFrom([state.utxo], data(redeemer)).attach.SpendingValidator(factoryScript)
  .pay.ToContract(deployment.factoryAddress, { kind: 'inline', value: data(c(0, [state.fields[0], state.fields[1], state.fields[2], state.fields[3] + 1n, state.fields[4]])) }, { ...state.utxo.assets });

// ---- Admin-created ADA/FT pool -----------------------------------------------------
const createAdminPool = (reserveA = 50_000_000n, reserveB = 200n) => submit('admin', async () => {
  const state = await factory(), name = poolName(state.fields[3]);
  const nft = deployment.poolPolicyId + name, lpUnit = deployment.lpPolicyId + name;
  const liquidity = integerSqrt(reserveA * reserveB);
  return factoryAdvance(lucid.newTx(), state, c(0))
    .mintAssets({ [nft]: 1n }, data(c(0))).mintAssets({ [lpUnit]: liquidity }, data(c(0, [assetData(t, asset(nft))])))
    .attach.MintingPolicy(poolPolicy).attach.MintingPolicy(lp)
    .pay.ToContract(deployment.ammAddress, { kind: 'inline', value: data(c(0, [assetData(t, asset(nft)), assetData(t, asset('lovelace')), assetData(t, asset(FT)), assetData(t, asset(lpUnit)), 997n, 1000n, reserveA, reserveB, liquidity, reserveA])) }, { lovelace: reserveA, [FT]: reserveB, [nft]: 1n })
    .pay.ToAddress(admin.address, { [lpUnit]: liquidity }).addSigner(admin.address);
});
await step('admin creates ADA/FT pool', () => createAdminPool());

const transition = (pool, redeemer, a, b, liquidity) => lucid.newTx().collectFrom([pool.utxo], data(redeemer)).attach.SpendingValidator(amm)
  .pay.ToContract(deployment.ammAddress, { kind: 'inline', value: data(nextDatum(t, pool, a, b, liquidity)) }, poolValue(pool, a, b));
const withFactory = async builder => builder.readFrom([(await factory()).utxo]);
const lpUnitOf = pool => assetUnit(pool.lpToken);

async function swap(role, quote, side, input, cheat = 0n, which = 'oldest') {
  const pool = await poolFor(quote, which);
  const [reserveIn, reserveOut] = side === 'a' ? [pool.reserveA, pool.reserveB] : [pool.reserveB, pool.reserveA];
  const output = quoteConstantProduct(input, reserveIn, reserveOut, pool.feeN, pool.feeD) + cheat;
  const [a, b] = side === 'a' ? [pool.reserveA + input, pool.reserveB - output] : [pool.reserveA - output, pool.reserveB + input];
  return withFactory(transition(pool, c(0, [output]), a, b, pool.liquidity));
}
async function addLiquidity(quote, requestedA) {
  const pool = await poolFor(quote), q = quoteLiquidityDeposit(requestedA, pool.reserveA, pool.reserveB, pool.liquidity);
  return withFactory(transition(pool, c(1, [q.lp]), pool.reserveA + q.amountA, pool.reserveB + q.amountB, pool.liquidity + q.lp)
    .mintAssets({ [lpUnitOf(pool)]: q.lp }, data(c(1, [assetData(t, pool.poolNft)]))).attach.MintingPolicy(lp));
}
async function removeLiquidity(quote, burn, cheat = 0n) {
  const pool = await poolFor(quote), q = quoteLiquidityWithdrawal(burn, pool.reserveA, pool.reserveB, pool.liquidity);
  const outA = q.amountA + cheat;
  return withFactory(transition(pool, c(2, [outA, q.amountB]), pool.reserveA - outA, pool.reserveB - q.amountB, pool.liquidity - burn)
    .mintAssets({ [lpUnitOf(pool)]: -burn }, data(c(2, [assetData(t, pool.poolNft)]))).attach.MintingPolicy(lp));
}

await step('LP adds liquidity', async () => {
  const hash = await submit('treasury', () => addLiquidity('lovelace', 5_000_000n));
  if (await balance(provider.address, lpUnitOf(await poolFor('lovelace'))) <= 0n) throw new Error('LP did not receive shares.');
  return hash;
});
await step('swap tADA -> FT', async () => {
  const before = await balance(attacker.address, FT);
  const hash = await submit('settlement', () => swap('settlement', 'lovelace', 'a', 3_000_000n));
  if (await balance(attacker.address, FT) <= before) throw new Error('Swap paid no FT.');
  return hash;
});
await step('swap FT -> tADA', () => submit('settlement', () => swap('settlement', 'lovelace', 'b', 5n)));
await step('LP removes part of its liquidity', async () => {
  const shares = await balance(provider.address, lpUnitOf(await poolFor('lovelace')));
  return submit('treasury', () => removeLiquidity('lovelace', shares / 2n));
});
await attack('swap takes one unit more than the constant product allows', 'settlement', () => swap('settlement', 'lovelace', 'a', 3_000_000n, 1n));
await attack('liquidity withdrawal overpays the quote side', 'treasury', async () => removeLiquidity('lovelace', await balance(provider.address, lpUnitOf(await poolFor('lovelace'))), 1n));

// ---- Three-party bootstrap ------------------------------------------------------
const FRACTION = 100n, QUOTE = 9_000_000n, BUFFER = 4_000_000n, SHARE = 5_000n;
const offerDatum = (quote, poolLovelace = BUFFER) => c(0, [addressData(t, owner.address), owner.key, assetData(t, factoryAsset), assetData(t, asset(FT)), FRACTION, assetData(t, asset(quote)), QUOTE, poolLovelace, SHARE]);
const createOffer = (quote, value = { lovelace: BUFFER, [FT]: FRACTION }, poolLovelace = BUFFER) =>
  submit('custody', () => lucid.newTx().pay.ToContract(deployment.bootstrapOfferAddress, { kind: 'inline', value: data(offerDatum(quote, poolLovelace)) }, value));
// The offer address is unparameterized and shared with every deployment: only
// consider this factory's offers from the test FT provider.
const offers = async quote => (await lucid.utxosAt(deployment.bootstrapOfferAddress)).filter(u => {
  if (!u.datum) return false;
  try {
    const f = t.Data.from(u.datum).fields;
    return f[1] === owner.key && f[2].fields[0] === factoryAsset.policyId && f[2].fields[1] === factoryAsset.assetName && f[5].fields[0] === asset(quote).policyId && f[5].fields[1] === asset(quote).assetName;
  } catch { return false; }
});
async function acceptance(offer, quote, { payer = provider, team = true, split = 0n } = {}) {
  const state = await factory(), name = poolName(state.fields[3]);
  const nft = deployment.poolPolicyId + name, lpUnit = deployment.lpPolicyId + name;
  const liquidity = integerSqrt(QUOTE * FRACTION), ownerLp = liquidity * SHARE / 10_000n;
  const ada = quote === 'lovelace';
  const pool = c(0, [assetData(t, asset(nft)), assetData(t, asset(quote)), assetData(t, asset(FT)), assetData(t, asset(lpUnit)), 997n, 1000n, QUOTE, FRACTION, liquidity, ada ? QUOTE : BUFFER]);
  let builder = factoryAdvance(lucid.newTx().collectFrom([offer], data(c(0, [addressData(t, payer.address), payer.key]))).attach.SpendingValidator(offerScript), state, c(1))
    .mintAssets({ [nft]: 1n }, data(c(0))).mintAssets({ [lpUnit]: liquidity }, data(c(0, [assetData(t, asset(nft))])))
    .attach.MintingPolicy(poolPolicy).attach.MintingPolicy(lp)
    .pay.ToContract(deployment.ammAddress, { kind: 'inline', value: data(pool) }, ada ? { lovelace: QUOTE, [FT]: FRACTION, [nft]: 1n } : { lovelace: BUFFER, [quote]: QUOTE, [FT]: FRACTION, [nft]: 1n })
    .pay.ToAddress(owner.address, { [lpUnit]: ownerLp - split })
    .pay.ToAddress(payer.address, { [lpUnit]: liquidity - ownerLp + split })
    .addSigner(payer.address);
  if (team) builder = builder.addSigner(admin.address);
  return builder;
}
// LP builds and signs; the Team reviews the exact CBOR, co-signs; the LP submits.
async function bootstrap(quote) {
  const [offer] = await offers(quote);
  as('treasury');
  const completed = await (await acceptance(offer, quote)).complete();
  const cbor = completed.toCBOR();
  as('admin');
  const reviewed = await reviewBootstrapTransaction(t, lucid, cbor, deployment, decodeCardanoAddress);
  if (!reviewed.result.ok) throw new Error('Team review rejected the approval: ' + reviewed.result.issues.join(' '));
  const teamWitness = await lucid.fromTx(cbor).partialSign.withWallet();
  as('treasury');
  const providerWitness = await lucid.fromTx(cbor).partialSign.withWallet();
  const signed = await lucid.fromTx(cbor).assemble([providerWitness, teamWitness]).complete();
  return settle(signed, await signed.submit());
}

for (const [label, quote] of [['tADA', 'lovelace'], ['token', USD]]) {
  await step(`bootstrap ${label}: FT provider locks offer`, () => createOffer(quote));
  await attack(`bootstrap ${label}: approval without Team signature`, 'treasury', async () => acceptance((await offers(quote))[0], quote, { team: false }));
  await attack(`bootstrap ${label}: LP allocation shifted by one share`, 'treasury', async () => acceptance((await offers(quote))[0], quote, { split: 1n }));
  if (quote === 'lovelace') await attack('bootstrap tADA: FT provider acts as its own LP', 'custody', async () => acceptance((await offers(quote))[0], quote, { payer: owner }));
  await step(`bootstrap ${label}: LP + Team approve, pool created`, async () => {
    const hash = await bootstrap(quote);
    const pool = await poolFor(quote, 'newest');
    if (await balance(owner.address, lpUnitOf(pool)) <= 0n || await balance(provider.address, lpUnitOf(pool)) <= 0n) throw new Error('LP shares were not split.');
    return hash;
  });
  if (quote !== 'lovelace') await step('fund trader with token quote', () => submit('treasury', () => lucid.newTx().pay.ToAddress(attacker.address, { lovelace: 2_000_000n, [USD]: 5_000_000n })));
  await step(`bootstrap ${label}: swap on new pool`, () => submit('settlement', () => swap('settlement', quote, 'a', 1_000_000n, 0n, 'newest')));
}

// ---- Cancellation, including the R04 malformed escrow ---------------------------
const cancelOffer = (offer, signer) => lucid.newTx().collectFrom([offer], data(c(1))).attach.SpendingValidator(offerScript).pay.ToAddress(owner.address, offer.assets).addSigner(signer);
await step('offer: lock then owner cancels', async () => {
  await createOffer('lovelace');
  const [offer] = await offers('lovelace');
  return submit('custody', () => cancelOffer(offer, owner.address));
});
await step('offer: lock malformed escrow (value exceeds datum)', () => createOffer('lovelace', { lovelace: BUFFER, [FT]: FRACTION }, 3_000_000n));
await attack('offer: malformed escrow cannot be accepted', 'treasury', async () => acceptance((await offers('lovelace'))[0], 'lovelace'));
await attack('offer: non-owner cancels', 'settlement', async () => cancelOffer((await offers('lovelace'))[0], attacker.address));
await step('offer: owner recovers malformed escrow', async () => {
  const before = await balance(owner.address, FT);
  const [offer] = await offers('lovelace');
  const hash = await submit('custody', () => cancelOffer(offer, owner.address));
  if (await balance(owner.address, FT) !== before + FRACTION) throw new Error('Malformed escrow was not refunded in full.');
  return hash;
});

// A fresh admin pool guarantees the close-authorization attack below has a
// live pool to target even when resuming after the other pools closed.
await step('fund admin FT for close-authorization pool', () => submit('custody', () => lucid.newTx().pay.ToAddress(admin.address, { lovelace: 2_000_000n, [FT]: 20n })));
await step('admin creates pool for close-authorization check', () => createAdminPool(5_000_000n, 20n));

// ---- Close every pool --------------------------------------------------------------
// Closure burns the whole LP supply, so the other holders return shares first.
for (const pool of (await pools()).sort((x, y) => x.poolNft.assetName.localeCompare(y.poolNft.assetName))) {
  await step(`close pool ${pool.poolNft.assetName} (${assetUnit(pool.assetA) === 'lovelace' ? 'tADA' : 'token'} quote)`, async () => {
    const lpUnit = lpUnitOf(pool);
    for (const role of ['custody', 'treasury', 'settlement']) {
      const held = await balance(wallets[role].address, lpUnit);
      if (held > 0n) await submit(role, () => lucid.newTx().pay.ToAddress(admin.address, { [lpUnit]: held }));
    }
    // With the whole LP supply in hand, a close lacking the admin signature
    // (attacker as the only required signer) must still be rejected.
    await attack(`pool ${pool.poolNft.assetName}: close without the factory admin signature`, 'admin', async () => {
      const current = (await pools()).find(p => p.id === pool.id);
      return withFactory(lucid.newTx().collectFrom([current.utxo], data(c(3, [addressData(t, attacker.address)]))).attach.SpendingValidator(amm)
        .mintAssets({ [assetUnit(current.poolNft)]: -1n }, data(c(1))).attach.MintingPolicy(poolPolicy)
        .mintAssets({ [lpUnit]: -current.liquidity }, data(c(3, [assetData(t, current.poolNft)]))).attach.MintingPolicy(lp)
        .pay.ToAddress(attacker.address, reservePayout(current)).addSigner(attacker.address));
    });
    const before = await balance(admin.address, FT);
    const hash = await submit('admin', async () => {
      const current = (await pools()).find(p => p.id === pool.id);
      return withFactory(lucid.newTx().collectFrom([current.utxo], data(c(3, [addressData(t, admin.address)]))).attach.SpendingValidator(amm)
        .mintAssets({ [assetUnit(current.poolNft)]: -1n }, data(c(1))).attach.MintingPolicy(poolPolicy)
        .mintAssets({ [lpUnit]: -current.liquidity }, data(c(3, [assetData(t, current.poolNft)]))).attach.MintingPolicy(lp)
        .pay.ToAddress(admin.address, reservePayout(current)).addSigner(admin.address));
    });
    if (await balance(admin.address, FT) <= before) throw new Error('Closure did not pay the reserves.');
    return hash;
  });
}
if ((await pools()).length || (await lucid.utxosAt(deployment.bootstrapOfferAddress)).some(u => u.datum && t.Data.from(u.datum).fields[1] === owner.key)) throw new Error('Test pools or offers remain.');
h.summary();
