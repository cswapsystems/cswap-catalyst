import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as t from '@lucid-evolution/lucid';
import { assertDeployment, bootstrapBuilder, freshDeployment, initialPoolDatum, referenceNames, referenceOutput } from '../scripts/lib/marketplace-deployment.mjs';
import { journaledSubmit } from '../scripts/marketplace-preprod.mjs';
import { buildMarketAction, decodeSharedPool } from '../src/lib/marketplace.ts';
const blueprint = JSON.parse(await readFile(new URL('../contracts/marketplace/plutus.json', import.meta.url), 'utf8'));
const code = Object.fromEntries(blueprint.validators.map(v => [v.title, v.compiledCode]));
const previous = JSON.parse(await readFile(new URL('../marketplace-deployment.preprod.json', import.meta.url), 'utf8'));

test('fresh deployment uses real one-shot identities, preserves registry entries and supports funded pool transactions', async () => {
  const account = t.generateEmulatorAccount({ lovelace: 2_000_000_000n });
  const emulator = new t.Emulator([account]), lucid = await t.Lucid(emulator, 'Preprod');
  lucid.selectWallet.fromSeed(account.seedPhrase);
  const team = t.getAddressDetails(account.address).paymentCredential.hash;
  const old = { ...previous, team, batcher: team, registry: { ...previous.registry, issuer: team } };
  const snapshot = { txHash: 'ab'.repeat(32), outputIndex: 0, address: old.registry.address,
    assets: { lovelace: 5_000_000n, [old.registry.token]: 1n },
    datum: t.Data.to(new t.Constr(0, [7n, [new t.Constr(0, ['cd'.repeat(28), '01'])]])) };
  const [seed] = await lucid.wallet().getUtxos();
  assert.throws(() => freshDeployment(code, old, seed, 'ff'.repeat(28), snapshot), /Team wallet/);
  assert.throws(() => freshDeployment(code, old, seed, team), /Registry blueprint/);
  const f = freshDeployment(code, old, seed, team, snapshot);
  assert.equal(f.deployment.registry.initialDatum, snapshot.datum);
  assert.equal(f.deployment.supersedes, old);
  assert.equal(t.Data.from(initialPoolDatum(f.deployment)).fields.length, 14);
  const submit = async builder => { const signed = await (await builder.complete()).sign.withWallet().complete(); await signed.submit(); emulator.awaitBlock(1); };
  await submit(bootstrapBuilder(lucid, f.deployment, f.identity, seed, f.registryIdentity));
  const registry = await lucid.utxoByUnit(f.deployment.registry.token);
  assert.equal(registry.datum, snapshot.datum);
  for (const name of referenceNames) {
    const o = referenceOutput(lucid, f.deployment, f.scripts[name]);
    await submit(lucid.newTx().pay.ToAddressWithData(o.address, { kind: 'inline', value: o.datum }, o.assets, o.scriptRef));
  }
  const refs = await lucid.utxosAt(f.deployment.referenceCustody.address);
  assert.equal(refs.length, 4);
  assert.equal((await lucid.wallet().getUtxos()).some(u => u.scriptRef), false);
  let poolUtxo = await lucid.utxoByUnit(f.deployment.pool.token);
  const verified = assertDeployment(code, f.deployment, poolUtxo, refs);
  assert.throws(() => assertDeployment(code, f.deployment, poolUtxo, [refs[0], refs[0], refs[0], refs[0]]), /four distinct/);
  assert.throws(() => assertDeployment(code, { ...f.deployment, orderbookAddress: account.address }, poolUtxo, refs), /addresses/);
  await submit(buildMarketAction(lucid, t, verified.scripts, account.address, { kind: 'deposit', amount: 30_000_000n }, verified.pool));
  poolUtxo = await lucid.utxoByUnit(f.deployment.pool.token);
  const pool = decodeSharedPool(t, poolUtxo);
  assert.equal(pool.supply, 50_000_000n);
  assert.throws(() => buildMarketAction(lucid, t, verified.scripts, account.address, { kind: 'withdraw', burned: pool.supply, acceptZero: true }, pool), /identity policy/);
});

test('submission recovery reuses persisted bytes and never rebuilds an ambiguous transaction', async () => {
  let builds = 0, persisted = false, submits = 0;
  const signed = { toHash: () => 'hash', toCBOR: () => 'cbor', toTransaction: () => ({ body: () => ({ inputs: () => ({ len: () => 0 }) }) }) };
  const ctx = { lucid: {
    wallet: () => ({ getUtxos: async () => [] }), overrideUTxOs() {}, clearUTxOOverride() {},
    fromTx: cbor => { assert.equal(cbor, 'cbor'); return signed; },
    transactionStatus: async () => ({ status: 'not_found' }),
    config: () => ({ provider: { submitTx: async cbor => { assert.ok(persisted); assert.equal(cbor, 'cbor'); submits++; if (submits === 1) throw new Error('Connection lost after submission'); return 'hash'; } } }),
    awaitTxConfirmation: async () => ({ txHash: 'hash' }),
  } };
  const journal = { transactions: {} };
  const builder = () => { builds++; return { complete: async () => ({ sign: { withWallet: () => ({ complete: async () => signed }) } }) }; };
  const persist = async () => { persisted = true; };
  await assert.rejects(journaledSubmit(ctx, journal, 'bootstrap', builder, persist), /Connection lost/);
  assert.equal(await journaledSubmit(ctx, journal, 'bootstrap', builder, persist), 'hash');
  assert.equal(builds, 1); assert.equal(submits, 2);
});

test('reference recovery rebuilds only a proven conflict and excludes stale spent wallet outputs', async () => {
  let builds = 0;
  const journal = { transactions: {
    bootstrap: { hash: 'confirmed', cbor: 'confirmed-cbor', inputs: ['spent#0'] },
    'reference-pool': { hash: 'rejected', cbor: 'rejected-cbor', inputs: ['spent#0'] },
  } };
  const signed = { toHash: () => 'replacement', toCBOR: () => 'replacement-cbor', toTransaction: () => ({ body: () => ({ inputs: () => ({ len: () => 0 }) }) }) };
  const ctx = { lucid: {
    wallet: () => ({ getUtxos: async () => [{ txHash: 'spent', outputIndex: 0 }, { txHash: 'available', outputIndex: 1 }] }),
    overrideUTxOs: outputs => assert.deepEqual(outputs, [{ txHash: 'available', outputIndex: 1 }]), clearUTxOOverride() {},
    fromTx: () => signed,
    transactionStatus: async hash => ({ status: hash === 'confirmed' ? 'confirmed' : 'not_found' }),
    config: () => ({ provider: { submitTx: async () => 'replacement' } }),
    awaitTxConfirmation: async () => ({ txHash: 'replacement' }),
  } };
  const builder = () => { builds++; return { complete: async () => ({ sign: { withWallet: () => ({ complete: async () => signed }) } }) }; };
  assert.equal(await journaledSubmit(ctx, journal, 'reference-pool', builder, async () => {}), 'replacement');
  assert.equal(builds, 1);
  assert.equal(journal.rejectedTransactions[0].hash, 'rejected');
  assert.equal(journal.rejectedTransactions[0].conflictsWith, 'confirmed');
});
