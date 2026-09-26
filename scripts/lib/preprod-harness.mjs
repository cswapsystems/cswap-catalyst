// Shared plumbing for the Preprod acceptance suites: demo-wallet selection,
// a resumable journal outside Playwright's cleared test-results/ output, indexing-safe submission, and
// attack checks that require rejection by both local and node evaluation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as t from '@lucid-evolution/lucid';

export const ROOT = new URL('../../', import.meta.url);
export const ROLES = ['admin', 'custody', 'treasury', 'settlement'];
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function preprodHarness(name, { watched = () => [] } = {}) {
  process.loadEnvFile(new URL('.env.local', ROOT));
  if (!process.env.BLOCKFROST_PROJECT_ID || !process.env.CARDANO_WALLET_SEED) throw new Error('BLOCKFROST_PROJECT_ID and CARDANO_WALLET_SEED are required.');
  const lucid = await t.Lucid(new t.Blockfrost('https://cardano-preprod.blockfrost.io/api/v0', process.env.BLOCKFROST_PROJECT_ID), 'Preprod');
  const phrases = { team: process.env.CARDANO_WALLET_SEED };
  for (const role of ROLES) phrases[role] = (await readFile(new URL(`wallets/${role}/seed.mnemonic`, ROOT), 'utf8')).trim();
  const wallets = {};
  for (const [role, phrase] of Object.entries(phrases)) {
    lucid.selectWallet.fromSeed(phrase);
    const address = await lucid.wallet().address();
    wallets[role] = { address, key: t.getAddressDetails(address).paymentCredential.hash };
  }
  const as = role => { lucid.selectWallet.fromSeed(phrases[role]); return wallets[role]; };

  const journalDir = new URL('.data/preprod-test-journals/', ROOT);
  const file = new URL(`${name}.json`, journalDir);
  const journal = await readFile(file, 'utf8').then(JSON.parse, () => ({ steps: {}, attacks: {} }));
  const save = async () => { await mkdir(journalDir, { recursive: true }); await writeFile(file, JSON.stringify(journal, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n'); };

  // Confirmation precedes Blockfrost indexing: wait until neither the signer's
  // wallet nor any watched view still reports an input this transaction spent.
  async function settle(signed, hash) {
    await lucid.awaitTx(hash, 5_000);
    const inputs = signed.toTransaction().body().inputs(), spent = new Set();
    for (let i = 0; i < inputs.len(); i++) spent.add(`${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`);
    const stale = utxos => !utxos || utxos.some(u => u && spent.has(`${u.txHash}#${u.outputIndex}`));
    for (let attempt = 0; attempt < 45; attempt++) {
      const views = await Promise.all([lucid.wallet().getUtxos().catch(() => null), ...watched(lucid, journal).map(view => view.catch(() => null))]);
      if (!views.some(stale)) break;
      await sleep(4_000);
    }
    await sleep(2_000);
    return hash;
  }
  // Lucid binds a builder to the wallet selected when newTx() runs, so select
  // the signer first and only then build.
  // A mempool conflict means an earlier transaction (e.g. from an interrupted
  // run) still holds an input: wait and rebuild from fresh chain state.
  async function submit(role, build) {
    for (let attempt = 0; ; attempt++) {
      as(role);
      const signed = await (await (await build()).complete()).sign.withWallet().complete();
      try {
        return await settle(signed, await signed.submit());
      } catch (error) {
        if (attempt >= 5 || !/All inputs are spent|BadInputsUTxO/.test(String(error?.message ?? error))) throw error;
        console.log(`  … inputs held by a pending transaction; retrying in 30s (${attempt + 1}/5)`);
        await sleep(30_000);
      }
    }
  }
  async function step(label, run) {
    if (journal.steps[label]) return console.log(`✓ ${label} (journaled ${journal.steps[label]})`);
    const hash = await run();
    journal.steps[label] = hash ?? 'ok';
    await save();
    console.log(`✓ ${label} ${hash ?? ''}`);
  }
  async function attack(label, role, build) {
    if (journal.attacks[label]?.rejected) return console.log(`✓ rejected: ${label} (journaled)`);
    const outcome = {};
    for (const localUPLCEval of [true, false]) {
      as(role);
      try {
        await (await build()).complete({ localUPLCEval });
        outcome[localUPLCEval ? 'local' : 'node'] = 'ACCEPTED';
      } catch (error) {
        outcome[localUPLCEval ? 'local' : 'node'] = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 400);
      }
    }
    // Only a validator rejection counts: a transaction that cannot even be
    // balanced (e.g. missing funds) never reaches the scripts.
    const scriptFailure = text => /failed script execution|EvaluationFailure|ScriptFailures|validator crashed/.test(text);
    outcome.rejected = scriptFailure(outcome.local) && scriptFailure(outcome.node);
    journal.attacks[label] = outcome;
    await save();
    console.log(`${outcome.rejected ? '✓ rejected' : '✗ NOT REJECTED BY A VALIDATOR'}: ${label}\n    local: ${outcome.local.slice(0, 160)}\n    node:  ${outcome.node.slice(0, 160)}`);
    if (!outcome.rejected) throw new Error(`Attack was not rejected by a validator: ${label}`);
  }
  const balance = async (address, unit) => (await lucid.utxosAt(address)).reduce((sum, u) => sum + (u.assets[unit] ?? 0n), 0n);
  function summary() {
    const failed = Object.entries(journal.attacks).filter(([, outcome]) => !outcome.rejected);
    console.log(`\nSteps: ${Object.keys(journal.steps).length} passed. Attacks: ${Object.keys(journal.attacks).length - failed.length}/${Object.keys(journal.attacks).length} rejected.`);
    if (failed.length) process.exit(1);
  }
  return { t, lucid, wallets, as, journal, save, submit, settle, step, attack, balance, summary };
}
