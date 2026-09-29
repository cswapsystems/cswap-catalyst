import assert from 'node:assert/strict';
import test from 'node:test';
import * as t from '@lucid-evolution/lucid';
import { readFile } from 'node:fs/promises';

const blueprint = JSON.parse(await readFile(new URL('../contracts/dex/plutus.json', import.meta.url), 'utf8'));
const code = title => blueprint.validators.find(v => v.title === title).compiledCode;
const script = (title, params = []) => ({ type: 'PlutusV3', script: params.length ? t.applyParamsToScript(code(title), params) : code(title) });
const data = fields => new t.Constr(0, fields);
const encoded = value => t.Data.to(value);
const asset = unit => data(unit === 'lovelace' ? ['', ''] : [unit.slice(0, 56), unit.slice(56)]);
const key = address => t.getAddressDetails(address).paymentCredential.hash;
const addressData = address => {
  const details = t.getAddressDetails(address);
  const credential = c => c.type === 'Key' ? { PubKeyCredential: [c.hash] } : { ScriptCredential: [c.hash] };
  return t.Data.from(t.Data.to({ addressCredential: credential(details.paymentCredential), addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null }, t.AddressSchema));
};
const ft = 'ab'.repeat(28) + '01';
const quoteToken = 'cd'.repeat(28) + '02';
const fractionAmount = 1000n, quoteAmount = 10_000_000n, buffer = 4_000_000n;

async function fixture() {
  const admin = t.generateEmulatorAccount({ lovelace: 1_000_000_000n });
  const owner = t.generateEmulatorAccount({ lovelace: 1_000_000_000n, [ft]: 10_000n, [quoteToken]: 100_000_000n });
  const provider = t.generateEmulatorAccount({ lovelace: 1_000_000_000n, [quoteToken]: 100_000_000n });
  const emulator = new t.Emulator([admin, owner, provider]);
  const lucid = await t.Lucid(emulator, 'Preprod');
  const select = who => lucid.selectWallet.fromSeed(who.seedPhrase);
  const submit = async builder => {
    const hash = await (await (await builder.complete()).sign.withWallet().complete()).submit();
    emulator.awaitBlock(1);
    return hash;
  };
  select(admin);
  const offerScript = script('bootstrap_offer.bootstrap_offer.spend');
  const offerAddress = t.validatorToAddress('Preprod', offerScript);
  const factoryScript = script('factory_state.factory_state.spend', [key(admin.address), addressData(offerAddress)]);
  const factoryAddress = t.validatorToAddress('Preprod', factoryScript);
  const seed = (await lucid.wallet().getUtxos())[0];
  const name = t.fromText('CSWAP_DEX_FACTORY');
  const identity = script('factory_bootstrap.factory_bootstrap.mint', [data([seed.txHash, BigInt(seed.outputIndex)]), addressData(factoryAddress), name]);
  const factoryToken = t.mintingPolicyToId(identity) + name;
  const amm = script('amm_pool.amm_pool.spend', [asset(factoryToken)]);
  const ammAddress = t.validatorToAddress('Preprod', amm);
  const lp = script('lp_policy.lp_policy.mint', [asset(factoryToken), addressData(ammAddress)]);
  const lpPolicyId = t.mintingPolicyToId(lp);
  const poolPolicy = script('pool_factory.pool_factory.mint', [asset(factoryToken), addressData(ammAddress), lpPolicyId]);
  const poolPolicyId = t.mintingPolicyToId(poolPolicy);
  await submit(lucid.newTx().collectFrom([seed]).mintAssets({ [factoryToken]: 1n }, encoded(data([]))).attach.MintingPolicy(identity).pay.ToContract(factoryAddress, { kind: 'inline', value: encoded(data([asset(factoryToken), key(admin.address), poolPolicyId, 0n, data([])])) }, { lovelace: 5_000_000n, [factoryToken]: 1n }).addSigner(admin.address));
  const deployment = { admin: key(admin.address), factoryToken, factoryAddress, ammAddress, lpPolicyId, poolPolicyId, offerAddress };
  const factory = () => lucid.utxoByUnit(factoryToken);
  async function open(quote = 'lovelace', ownerShare = 5000n) {
    select(owner);
    const terms = data([addressData(owner.address), key(owner.address), asset(factoryToken), asset(ft), fractionAmount, asset(quote), quoteAmount, buffer, ownerShare]);
    await submit(lucid.newTx().pay.ToContract(offerAddress, { kind: 'inline', value: encoded(data([terms])) }, { lovelace: buffer, [ft]: fractionAmount }));
    return (await lucid.utxosAt(offerAddress))[0];
  }
  async function fund(openUtxo, quote = 'lovelace', signer = provider) {
    select(signer);
    const state = await factory();
    const terms = t.Data.from(openUtxo.datum).fields[0];
    const value = quote === 'lovelace' ? { lovelace: quoteAmount, [ft]: fractionAmount } : { lovelace: buffer, [ft]: fractionAmount, [quote]: quoteAmount };
    await submit(lucid.newTx().collectFrom([openUtxo], encoded(data([addressData(signer.address), key(signer.address)]))).readFrom([state]).attach.SpendingValidator(offerScript).pay.ToContract(offerAddress, { kind: 'inline', value: encoded(new t.Constr(1, [terms, addressData(signer.address), key(signer.address)])) }, value).addSigner(signer.address));
    return (await lucid.utxosAt(offerAddress))[0];
  }
  async function finalize(funded, quote = 'lovelace', signer = admin, split = 0n) {
    select(signer);
    const state = await factory();
    const before = t.Data.from(state.datum).fields;
    const name = before[3].toString(16).padStart(16, '0');
    const nft = poolPolicyId + name, lpToken = lpPolicyId + name;
    const ownerShare = t.Data.from(funded.datum).fields[0].fields[8];
    const ownerLp = 100_000n * ownerShare / 10_000n;
    const providerLp = 100_000n - ownerLp;
    const poolLovelace = quote === 'lovelace' ? quoteAmount : buffer;
    const poolDatum = data([asset(nft), asset(quote), asset(ft), asset(lpToken), 997n, 1000n, quoteAmount, fractionAmount, 100_000n, poolLovelace]);
    const poolValue = quote === 'lovelace' ? { lovelace: poolLovelace, [ft]: fractionAmount, [nft]: 1n } : { lovelace: poolLovelace, [quote]: quoteAmount, [ft]: fractionAmount, [nft]: 1n };
    let builder = lucid.newTx().collectFrom([funded], encoded(new t.Constr(1, []))).collectFrom([state], encoded(new t.Constr(1, [])))
      .mintAssets({ [nft]: 1n }, encoded(data([]))).mintAssets({ [lpToken]: 100_000n }, encoded(data([asset(nft)])))
      .attach.SpendingValidator(offerScript).attach.SpendingValidator(factoryScript).attach.MintingPolicy(poolPolicy).attach.MintingPolicy(lp)
      .pay.ToContract(factoryAddress, { kind: 'inline', value: encoded(data([before[0], before[1], before[2], before[3] + 1n, before[4]])) }, { ...state.assets })
      .pay.ToContract(ammAddress, { kind: 'inline', value: encoded(poolDatum) }, poolValue)
      .pay.ToAddress(owner.address, { [lpToken]: ownerLp - split });
    if (providerLp + split > 0n) builder = builder.pay.ToAddress(provider.address, { [lpToken]: providerLp + split });
    return builder.addSigner(signer.address).complete();
  }
  const cancel = (utxo, signer = owner) => lucid.newTx().collectFrom([utxo], encoded(new t.Constr(2, []))).attach.SpendingValidator(offerScript).pay.ToAddress(owner.address, { ...utxo.assets }).addSigner(signer.address);
  return { admin, owner, provider, lucid, emulator, select, submit, open, fund, finalize, cancel, deployment };
}

test('LP funds escrow on-chain, owner cannot cancel, and Team alone creates ADA and token pools', async () => {
  const f = await fixture();
  for (const quote of ['lovelace', quoteToken]) {
    const opened = await f.open(quote);
    const funded = await f.fund(opened, quote);
    assert.equal(t.Data.from(funded.datum).index, 1);
    f.select(f.owner);
    await assert.rejects(f.cancel(funded).complete(), /./, 'owner must not cancel funded escrow');
    f.select(f.provider);
    await assert.rejects(f.finalize(funded, quote, f.provider), /./, 'provider cannot create pool');
    f.select(f.admin);
    await assert.rejects(f.finalize(funded, quote, f.admin, 1n), /./, 'Team cannot change LP allocation');
    const completed = await f.finalize(funded, quote);
    await (await completed.sign.withWallet().complete()).submit();
    f.emulator.awaitBlock(1);
    assert.equal((await f.lucid.utxosAt(f.deployment.offerAddress)).length, 0);
  }
  assert.equal((await f.lucid.utxosAt(f.deployment.ammAddress)).length, 2);
});

test('owner can cancel only an open offer', async () => {
  const f = await fixture();
  const opened = await f.open();
  f.select(f.provider);
  await assert.rejects(f.cancel(opened, f.provider).complete(), /./);
  f.select(f.owner);
  await f.submit(f.cancel(opened));
  assert.equal((await f.lucid.utxosAt(f.deployment.offerAddress)).length, 0);
});

test('owner cannot fund a split offer and Team cannot fund any offer', async () => {
  const f = await fixture();
  const opened = await f.open();
  await assert.rejects(f.fund(opened, 'lovelace', f.owner), /./);
  await assert.rejects(f.fund(opened, 'lovelace', f.admin), /./);
});

test('FT owner funds both sides and receives the full LP supply for ADA and token quotes', async () => {
  const f = await fixture();
  for (const quote of ['lovelace', quoteToken]) {
    const opened = await f.open(quote, 10_000n);
    await assert.rejects(f.fund(opened, quote, f.provider), /./, 'another wallet cannot fund a 100% owner offer');
    const funded = await f.fund(opened, quote, f.owner);
    f.select(f.owner);
    await assert.rejects(f.cancel(funded).complete(), /./, 'owner cannot cancel after self funding');
    f.select(f.admin);
    await assert.rejects(f.finalize(funded, quote, f.admin, 1n), /./, 'Team cannot divert LP tokens');
    const completed = await f.finalize(funded, quote);
    await (await completed.sign.withWallet().complete()).submit();
    f.emulator.awaitBlock(1);
  }
  const ownerAssets = await f.lucid.utxosAt(f.owner.address);
  const lpBalances = Object.entries(ownerAssets.reduce((total, utxo) => {
    for (const [unit, amount] of Object.entries(utxo.assets)) total[unit] = (total[unit] ?? 0n) + amount;
    return total;
  }, {})).filter(([unit]) => unit.startsWith(f.deployment.lpPolicyId));
  assert.equal(lpBalances.length, 2);
  assert(lpBalances.every(([, amount]) => amount === 100_000n));
});
