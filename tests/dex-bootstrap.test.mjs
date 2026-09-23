import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as t from '@lucid-evolution/lucid';
import { reviewBootstrapTransaction } from '../src/lib/bootstrap-review.ts';
import { decodeCardanoAddress } from '../src/lib/address-codec.ts';
import { assertBootstrapMinimumAda } from '../src/lib/bootstrap-values.ts';

const blueprint = JSON.parse(await readFile(new URL('../contracts/dex/plutus.json', import.meta.url), 'utf8'));
const code = title => blueprint.validators.find(v => v.title === title).compiledCode;
const script = (title, params = []) => ({ type: 'PlutusV3', script: params.length ? t.applyParamsToScript(code(title), params) : code(title) });
const data = fields => new t.Constr(0, fields);
const asset = unit => data(unit === 'lovelace' ? ['', ''] : [unit.slice(0, 56), unit.slice(56)]);
const key = address => t.getAddressDetails(address).paymentCredential.hash;
const addressData = address => {
  const d = t.getAddressDetails(address);
  const credential = c => c.type === 'Key' ? { PubKeyCredential: [c.hash] } : { ScriptCredential: [c.hash] };
  return t.Data.from(t.Data.to({ addressCredential: credential(d.paymentCredential), addressStakingCredential: d.stakeCredential ? { StakingHash: [credential(d.stakeCredential)] } : null }, t.AddressSchema));
};
const ft = 'ab'.repeat(28) + '01', quoteToken = 'cd'.repeat(28) + '02';

async function fixture() {
  const admin = t.generateEmulatorAccount({ lovelace: 1_000_000_000n, [ft]: 10_000n });
  const owner = t.generateEmulatorAccount({ lovelace: 1_000_000_000n, [ft]: 10_000n });
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
  const deployment = { admin: key(admin.address), factoryToken, factoryAddress, ammAddress, lpPolicyId, poolPolicyId, bootstrapOfferAddress: offerAddress };
  await submit(lucid.newTx().collectFrom([seed]).mintAssets({ [factoryToken]: 1n }, t.Data.to(data([]))).attach.MintingPolicy(identity).pay.ToContract(factoryAddress, { kind: 'inline', value: t.Data.to(data([asset(factoryToken), key(admin.address), poolPolicyId, 0n, data([])])) }, { lovelace: 5_000_000n, [factoryToken]: 1n }).addSigner(admin.address));
  async function offer(quote = 'lovelace', buffer = 4_000_000n) {
    select(owner);
    await submit(lucid.newTx().pay.ToContract(offerAddress, { kind: 'inline', value: t.Data.to(data([addressData(owner.address), key(owner.address), asset(factoryToken), asset(ft), 1000n, asset(quote), 10_000_000n, buffer, 5000n])) }, { lovelace: buffer, [ft]: 1000n }));
    return (await lucid.utxosAt(offerAddress))[0];
  }
  async function accept(offerUtxo, quote = 'lovelace', options = {}) {
    const payer = options.payer ?? provider;
    select(payer);
    const state = await lucid.utxoByUnit(factoryToken);
    const before = t.Data.from(state.datum).fields;
    const name = before[3].toString(16).padStart(16, '0');
    const nft = poolPolicyId + name, lpUnit = lpPolicyId + name;
    const pool = data([asset(nft), asset(quote), asset(ft), asset(lpUnit), 997n, 1000n, 10_000_000n, 1000n, 100_000n, quote === 'lovelace' ? 10_000_000n : 4_000_000n]);
    let builder = lucid.newTx()
      .collectFrom([offerUtxo], t.Data.to(data([addressData(payer.address), key(payer.address)])))
      .collectFrom([state], t.Data.to(new t.Constr(1, [])))
      .mintAssets({ [nft]: 1n }, t.Data.to(data([])))
      .mintAssets({ [lpUnit]: 100_000n }, t.Data.to(data([asset(nft)])))
      .attach.SpendingValidator(offerScript).attach.SpendingValidator(factoryScript).attach.MintingPolicy(poolPolicy).attach.MintingPolicy(lp)
      .pay.ToContract(factoryAddress, { kind: 'inline', value: t.Data.to(data([before[0], before[1], before[2], before[3] + 1n, before[4]])) }, { ...state.assets })
      .pay.ToContract(ammAddress, { kind: 'inline', value: t.Data.to(pool) }, quote === 'lovelace' ? { lovelace: 10_000_000n, [ft]: 1000n, [nft]: 1n } : { lovelace: 4_000_000n, [quote]: 10_000_000n, [ft]: 1000n, [nft]: 1n })
      .pay.ToAddress(owner.address, { [lpUnit]: options.wrongSplit ? 49_999n : 50_000n })
      .pay.ToAddress(payer.address, { [lpUnit]: options.wrongSplit ? 50_001n : 50_000n });
    if (!options.missingTeam) builder = builder.addSigner(admin.address);
    if (!options.missingProvider) builder = builder.addSigner(payer.address);
    return builder.complete();
  }
  async function create(lpIndex = 0) {
    select(admin);
    const state = await lucid.utxoByUnit(factoryToken);
    const before = t.Data.from(state.datum).fields;
    const name = before[3].toString(16).padStart(16, '0');
    const nft = poolPolicyId + name, lpUnit = lpPolicyId + name;
    return lucid.newTx().collectFrom([state], t.Data.to(data([])))
      .mintAssets({ [nft]: 1n }, t.Data.to(data([])))
      .mintAssets({ [lpUnit]: 100_000n }, t.Data.to(new t.Constr(lpIndex, [asset(nft)])))
      .attach.SpendingValidator(factoryScript).attach.MintingPolicy(poolPolicy).attach.MintingPolicy(lp)
      .pay.ToContract(factoryAddress, { kind: 'inline', value: t.Data.to(data([before[0], before[1], before[2], before[3] + 1n, before[4]])) }, { ...state.assets })
      .pay.ToContract(ammAddress, { kind: 'inline', value: t.Data.to(data([asset(nft), asset('lovelace'), asset(ft), asset(lpUnit), 997n, 1000n, 10_000_000n, 1000n, 100_000n, 10_000_000n])) }, { lovelace: 10_000_000n, [ft]: 1000n, [nft]: 1n })
      .pay.ToAddress(admin.address, { [lpUnit]: 100_000n }).addSigner(admin.address).complete();
  }
  return { admin, owner, provider, emulator, lucid, select, submit, offer, accept, create, offerScript, deployment };
}

test('three-party bootstrap executes real validators for ADA and token quotes', async () => {
  const f = await fixture();
  for (const quote of ['lovelace', quoteToken]) {
    const offer = await f.offer(quote);
    await assert.rejects(f.accept(offer, quote, { missingTeam: true }), /./, 'missing Team signature must fail validation');
    await assert.rejects(f.accept(offer, quote, { missingProvider: true }), /./, 'missing provider signature must fail validation');
    await assert.rejects(f.accept(offer, quote, { wrongSplit: true }), /./, 'incorrect owner payout must fail validation');
    if (quote === 'lovelace') {
      await assert.rejects(f.accept(offer, quote, { payer: f.owner }), /./, 'FT provider cannot be the LP');
      await assert.rejects(f.accept(offer, quote, { payer: f.admin }), /./, 'Team creator cannot be the LP');
    }
    const completed = await f.accept(offer, quote);
    const cbor = completed.toCBOR();
    const reviewed = await reviewBootstrapTransaction(t, f.lucid, cbor, f.deployment, decodeCardanoAddress);
    assert.equal(reviewed.result.ok, true, reviewed.result.issues.join(' '));
    const providerWitness = await completed.partialSign.withWallet();
    f.select(f.admin);
    const teamWitness = await f.lucid.fromTx(cbor).partialSign.withWallet();
    await (await f.lucid.fromTx(cbor).assemble([providerWitness, teamWitness]).complete()).submit();
    f.emulator.awaitBlock(1);
    await assert.rejects(reviewBootstrapTransaction(t, f.lucid, cbor, f.deployment, decodeCardanoAddress), /spent|unavailable|live|continuation/);
  }
  assert.equal((await f.lucid.utxosAt(f.deployment.ammAddress)).length, 2);
});

test('minimum-ADA guard prevents silently topped-up immutable escrow', async () => {
  const low = await fixture();
  await assert.rejects(low.accept(await low.offer('lovelace', 1_999_999n)), /./);
  const exact = await fixture();
  const offer = await exact.offer('lovelace', 2_000_000n);
  // With this datum, the builder tops up 2 ADA; locking that altered value
  // would strand the escrow because the validator enforces exact equality.
  assert.ok(offer.assets.lovelace > 2_000_000n);
  const parameters = exact.lucid.config().protocolParameters;
  assert.throws(() => assertBootstrapMinimumAda(t, parameters.coinsPerUtxoByte, [{ ...offer, label: 'Offer escrow', assets: { ...offer.assets, lovelace: 2_000_000n } }]), /Increase the ADA buffer/);
  assert.doesNotThrow(() => assertBootstrapMinimumAda(t, parameters.coinsPerUtxoByte, [{ ...offer, label: 'Offer escrow', assets: { ...offer.assets, lovelace: 4_000_000n } }]));
});

test('FT provider may cancel an offer but the Team wallet cannot substitute for its owner', async () => {
  const f = await fixture();
  const offer = await f.offer();
  const cancel = who => f.lucid.newTx().collectFrom([offer], t.Data.to(new t.Constr(1, []))).attach.SpendingValidator(f.offerScript).pay.ToAddress(f.owner.address, { ...offer.assets }).addSigner(who.address);
  f.select(f.admin);
  await assert.rejects(cancel(f.admin).complete(), /./);
  f.select(f.owner);
  await f.submit(cancel(f.owner));
  assert.equal((await f.lucid.utxosAt(f.deployment.bootstrapOfferAddress)).length, 0);
});

test('standard admin creation uses Bootstrap LP redeemer, not MintLp', async () => {
  const f = await fixture();
  await assert.rejects(f.create(1), /./);
  const completed = await f.create(0);
  await (await completed.sign.withWallet().complete()).submit();
  f.emulator.awaitBlock(1);
  assert.equal((await f.lucid.utxosAt(f.deployment.ammAddress)).length, 1);
});

test('Team CBOR review rejects collateral theft, governance, extra signers, and mismatched deployments', async () => {
  const f = await fixture();
  const offer = await f.offer();
  const completed = await f.accept(offer);
  const cbor = completed.toCBOR();
  const review = (value, deployment = f.deployment) => reviewBootstrapTransaction(t, f.lucid, value, deployment, decodeCardanoAddress);
  const mutate = change => {
    const tx = t.CML.Transaction.from_cbor_hex(cbor);
    const body = tx.body();
    change(body);
    return t.CML.Transaction.new(body, tx.witness_set(), true, tx.auxiliary_data()).to_cbor_hex();
  };
  const adminUtxo = (await f.lucid.utxosAt(f.admin.address))[0];
  const theft = mutate(body => {
    const inputs = t.CML.TransactionInputList.new();
    inputs.add(t.CML.TransactionInput.new(t.CML.TransactionHash.from_hex(adminUtxo.txHash), BigInt(adminUtxo.outputIndex)));
    body.set_collateral_inputs(inputs);
  });
  await assert.rejects(review(theft), /provider may supply collateral/);
  await assert.rejects(review(mutate(body => body.set_donation(1n))), /governance/);
  const extraSigner = mutate(body => {
    const signers = body.required_signers();
    signers.add(t.CML.Ed25519KeyHash.from_hex(key(f.owner.address)));
    body.set_required_signers(signers);
  });
  assert.equal((await review(extraSigner)).result.ok, false);
  await assert.rejects(review(cbor, { ...f.deployment, factoryToken: 'ff'.repeat(28) + '01' }), /another factory/);
  await assert.rejects(review(cbor, { ...f.deployment, factoryAddress: f.admin.address }), /Factory identity/);
  await assert.rejects(review('00'), /./);
});
