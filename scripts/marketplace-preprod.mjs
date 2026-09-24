import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as t from '@lucid-evolution/lucid';
import { buildMarketAction } from '../src/lib/marketplace.ts';
import { assertDeployment, blueprintDigest, bootstrapBuilder, deploymentScripts, freshDeployment, referenceNames, referenceOutput } from './lib/marketplace-deployment.mjs';

const DEPLOYMENT = new URL('../marketplace-deployment.preprod.json', import.meta.url);
const PENDING = new URL('../marketplace-deployment.preprod.pending.json', import.meta.url);
const read = file => readFile(file, 'utf8').then(JSON.parse);
async function optionalRead(file) {
  try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(file, value) {
  const temporary = new URL(file.href + '.tmp');
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
async function context() {
  // Node parses quoted dotenv values without printing credentials.
  process.loadEnvFile(new URL('../.env.local', import.meta.url));
  const { CARDANO_WALLET_SEED: seed, BLOCKFROST_PROJECT_ID: key } = process.env;
  if (!seed || !key) throw new Error('CARDANO_WALLET_SEED and BLOCKFROST_PROJECT_ID are required.');
  const provider = new t.Blockfrost('https://cardano-preprod.blockfrost.io/api/v0', key);
  const lucid = await t.Lucid(provider, 'Preprod');
  lucid.selectWallet.fromSeed(seed);
  const address = await lucid.wallet().address();
  const credential = t.getAddressDetails(address).paymentCredential;
  if (credential?.type !== 'Key') throw new Error('A Team payment-key wallet is required.');
  const blueprint = await read(new URL('../contracts/marketplace/plutus.json', import.meta.url));
  return { lucid, address, teamKey: credential.hash, code: Object.fromEntries(blueprint.validators.map(v => [v.title, v.compiledCode])) };
}
async function verify(ctx, deployment) {
  const [pool, references, registry] = await Promise.all([
    ctx.lucid.utxoByUnit(deployment.pool.token), ctx.lucid.utxosByOutRef(deployment.referenceScripts || []), ctx.lucid.utxoByUnit(deployment.registry.token),
  ]);
  if (registry.address !== deployment.registry.address || registry.assets[deployment.registry.token] !== 1n) throw new Error('Registry identity/address mismatch.');
  return assertDeployment(ctx.code, deployment, pool, references);
}
function publicOverrides(deployment) {
  const expected = {
    NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS: deployment.orderbookAddress,
    NEXT_PUBLIC_QUOTE_POOL_ADDRESS: deployment.pool.address,
    NEXT_PUBLIC_ASSET_REGISTRY_TOKEN: deployment.registry.token,
    NEXT_PUBLIC_ASSET_REGISTRY_ISSUER: deployment.registry.issuer,
    NEXT_PUBLIC_TEAM_KEY_HASH: deployment.team,
  };
  return Object.entries(expected).filter(([name, value]) => process.env[name] && process.env[name] !== value).map(([name, expected]) => ({ name, expected }));
}
async function plan(ctx, previous) {
  const wallet = await ctx.lucid.wallet().getUtxos();
  const seed = wallet.find(u => !u.scriptRef && Object.keys(u.assets).length === 1 && u.assets.lovelace >= 30_000_000n);
  if (!seed) throw new Error('An ADA-only UTxO containing at least 30 tADA is required.');
  const [registry, pool, listings] = await Promise.all([
    ctx.lucid.utxoByUnit(previous.registry.token), ctx.lucid.utxoByUnit(previous.pool.token), ctx.lucid.utxosAt(previous.orderbookAddress),
  ]);
  if (registry.address !== previous.registry.address) throw new Error('Existing registry cannot be reused: identity is not at the configured address.');
  const fresh = freshDeployment(ctx.code, previous, seed, ctx.teamKey, process.argv.includes('--replace-registry') ? registry : undefined);
  const referenceLovelace = referenceNames.reduce((sum, name) => sum + referenceOutput(ctx.lucid, fresh.deployment, fresh.scripts[name]).assets.lovelace, 0n);
  const available = wallet.filter(u => !u.scriptRef).reduce((sum, u) => sum + u.assets.lovelace, 0n);
  const minimum = BigInt(fresh.deployment.pool.minCashReserve) + referenceLovelace + 10_000_000n + (fresh.registryIdentity ? 5_000_000n : 0n);
  if (available < minimum) throw new Error(`Insufficient test ADA: need at least ${minimum} lovelace including fee/collateral buffer, have ${available}.`);
  // Build/evaluate the bootstrap without signing or submitting it.
  ctx.lucid.overrideUTxOs(wallet.filter(u => !u.scriptRef));
  let bootstrap = bootstrapBuilder(ctx.lucid, fresh.deployment, fresh.identity, seed, fresh.registryIdentity);
  if (fresh.registryIdentity) bootstrap = bootstrap.readFrom([registry]);
  const unsigned = await bootstrap.complete();
  ctx.lucid.clearUTxOOverride();
  console.log(JSON.stringify({ mode: 'read-only deployment plan', team: ctx.teamKey,
    orderbookAddress: fresh.deployment.orderbookAddress, poolAddress: fresh.deployment.pool.address,
    registryReplaced: Boolean(fresh.registryIdentity), registryToken: fresh.deployment.registry.token, referenceDepositsLovelace: referenceLovelace.toString(),
    minimumWalletLovelace: minimum.toString(), bootstrapFeeLovelace: unsigned.toTransaction().body().fee().toString(),
    previousStateUntouched: { pool: `${pool.txHash}#${pool.outputIndex}`, cashLovelace: pool.assets.lovelace.toString(), orderbookOutputs: listings.length },
    stalePublicOverrides: publicOverrides(fresh.deployment),
    limitation: 'No migration of old listings or liquidity. Final LP exit requires the recorded burn-capable pool identity seed.',
  }, null, 2));
  return { ...fresh, seed };
}

// Persist signed transactions before submission. Resuming rebroadcasts the same
// bytes/hash, never creates a second identity when confirmation is ambiguous.
function inputRefs(transaction) {
  const inputs = transaction.body().inputs();
  return Array.from({ length: inputs.len() }, (_, index) => {
    const input = inputs.get(index);
    return `${input.transaction_id().to_hex()}#${input.index()}`;
  });
}
const recordedInputs = entry => entry.inputs || inputRefs(t.CML.Transaction.from_cbor_hex(entry.cbor));
export async function journaledSubmit(ctx, journal, label, builder, persist) {
  let entry = journal.transactions[label];
  if (entry && label.startsWith('reference-') && (await ctx.lucid.transactionStatus(entry.hash)).status === 'not_found') {
    // Blockfrost can report confirmation before its address UTxO index catches up.
    // Rebuild ONLY when a different, confirmed journal transaction demonstrably
    // consumed an input. A timeout/not-found response alone is never sufficient.
    for (const [otherLabel, other] of Object.entries(journal.transactions)) {
      if (otherLabel === label || !recordedInputs(other).some(input => recordedInputs(entry).includes(input))) continue;
      if ((await ctx.lucid.transactionStatus(other.hash)).status !== 'confirmed') continue;
      (journal.rejectedTransactions ||= []).push({ label, ...entry, conflictsWith: other.hash });
      delete journal.transactions[label]; await persist(); entry = undefined;
      console.log(`Rebuilding ${label}: its input was consumed by confirmed ${other.hash}.`);
      break;
    }
  }
  if (!entry) {
    const utxos = await ctx.lucid.wallet().getUtxos();
    const spent = new Set(Object.values(journal.transactions).flatMap(recordedInputs));
    ctx.lucid.overrideUTxOs(utxos.filter(u => !u.scriptRef && !spent.has(`${u.txHash}#${u.outputIndex}`)));
    let signed;
    try { signed = await (await builder().complete()).sign.withWallet().complete(); }
    finally { ctx.lucid.clearUTxOOverride(); }
    entry = journal.transactions[label] = { hash: signed.toHash(), cbor: signed.toCBOR(), inputs: inputRefs(signed.toTransaction()) };
    await persist();
  }
  if (ctx.lucid.fromTx(entry.cbor).toHash() !== entry.hash) throw new Error('Pending transaction bytes/hash mismatch.');
  const status = await ctx.lucid.transactionStatus(entry.hash);
  if (status.status === 'failed') throw new Error(`Pending ${label} failed; inspect ${entry.hash} before any retry.`);
  if (status.status === 'not_found') {
    const submitted = await ctx.lucid.config().provider.submitTx(entry.cbor);
    if (submitted !== entry.hash) throw new Error('Submitted transaction hash mismatch.');
  }
  console.log(`${label}: ${entry.hash}`);
  await ctx.lucid.awaitTxConfirmation(entry.hash, { timeout: 120_000, checkInterval: 3_000 });
  return entry.hash;
}

async function redeploy(ctx, previous) {
  if (!process.argv.includes('--confirm-fresh-testnet')) throw new Error('Run plan-redeploy first. Fresh deployment spends test ADA and does not migrate old positions. Approval requires --confirm-fresh-testnet.');
  let journal = await optionalRead(PENDING);
  if (journal?.published && journal.deployment.pool.token === previous.pool.token) {
    await verify(ctx, previous);
    console.log('Deployment already published and verified. No transactions submitted.'); return;
  }
  if (!journal) {
    const fresh = await plan(ctx, previous);
    journal = { deployment: fresh.deployment, seed: { txHash: fresh.seed.txHash, outputIndex: fresh.seed.outputIndex }, identity: fresh.identity, registryIdentity: fresh.registryIdentity, transactions: {} };
    // Exclusive creation prevents a second process from replacing the seed journal.
    await writeFile(PENDING, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const deployment = journal.deployment;
  if (deployment.blueprintDigest !== blueprintDigest(ctx.code) || deployment.team !== ctx.teamKey ||
    (JSON.stringify(deployment.supersedes) !== JSON.stringify(previous) && JSON.stringify(deployment) !== JSON.stringify(previous))) throw new Error('Pending deployment/blueprint/admin differs from the current configuration. Review the pending journal; do not discard it.');
  const persist = () => save(PENDING, journal);
  const scripts = deploymentScripts(ctx.code, deployment);
  if (journal.registryIdentity && !process.argv.includes('--replace-registry')) throw new Error('Pending deployment includes a registry replacement; --replace-registry is required.');
  let registrySnapshot;
  if (journal.registryIdentity && !journal.transactions.bootstrap) {
    const current = await ctx.lucid.utxoByUnit(deployment.supersedes.registry.token);
    if (current.txHash !== deployment.registry.copiedFrom.txHash || current.outputIndex !== deployment.registry.copiedFrom.outputIndex || current.datum !== deployment.registry.initialDatum) throw new Error('Registry changed since preflight. Review and rebuild the unsubmitted deployment journal.');
    registrySnapshot = current;
  }
  const [seed] = journal.transactions.bootstrap ? [] : await ctx.lucid.utxosByOutRef([journal.seed]);
  deployment.pool.transaction = await journaledSubmit(ctx, journal, 'bootstrap', () => {
    if (!seed) throw new Error('Bootstrap seed unavailable. Review the pending journal.');
    const builder = bootstrapBuilder(ctx.lucid, deployment, journal.identity, seed, journal.registryIdentity);
    return registrySnapshot ? builder.readFrom([registrySnapshot]) : builder;
  }, persist);
  if (journal.registryIdentity) deployment.registry.transaction = deployment.pool.transaction;
  await persist();
  deployment.referenceScripts = [];
  for (const name of referenceNames) {
    const output = referenceOutput(ctx.lucid, deployment, scripts[name]);
    const hash = await journaledSubmit(ctx, journal, `reference-${name}`, () => ctx.lucid.newTx()
      .pay.ToAddressWithData(output.address, { kind: 'inline', value: output.datum }, output.assets, output.scriptRef), persist);
    let ref;
    for (let attempt = 0; attempt < 12 && !ref; attempt++) {
      const outputs = await ctx.lucid.utxosAt(output.address);
      ref = outputs.find(u => u.txHash === hash && u.scriptRef && t.validatorToScriptHash(u.scriptRef) === t.validatorToScriptHash(scripts[name]));
      if (!ref) await new Promise(resolve => setTimeout(resolve, 2500));
    }
    if (!ref) throw new Error(`Confirmed ${name} reference is missing. Do not publish this manifest.`);
    deployment.referenceScripts.push({ txHash: ref.txHash, outputIndex: ref.outputIndex });
    await persist();
  }
  await verify(ctx, deployment);
  // Never publish a partial deployment; leave the previous manifest active on failure.
  await save(DEPLOYMENT, deployment);
  journal.published = true; await persist();
  console.log('Fresh marketplace verified and published locally. Rebuild/deploy the app to use it.');
  console.log(JSON.stringify({ stalePublicOverrides: publicOverrides(deployment) }, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (!['plan-redeploy', 'redeploy', 'status', 'fund', 'register'].includes(command)) throw new Error('Usage: npm run marketplace:preprod -- plan-redeploy|redeploy --confirm-fresh-testnet|status|fund <lovelace>|register <asset-unit>');
  const ctx = await context(), deployment = await read(DEPLOYMENT);
  if (command === 'plan-redeploy') return plan(ctx, deployment);
  if (command === 'redeploy') {
    const lock = new URL(PENDING.href + '.lock');
    const handle = await open(lock, 'wx');
    try { return await redeploy(ctx, deployment); }
    finally { await handle.close(); await unlink(lock); }
  }
  if (command === 'status') {
    const { pool } = await verify(ctx, deployment);
    console.log(JSON.stringify({ compatible: true, pool: `${pool.utxo.txHash}#${pool.utxo.outputIndex}`, cash: pool.cash.toString(), supply: pool.supply.toString(), referenceScripts: 4, stalePublicOverrides: publicOverrides(deployment) }, null, 2)); return;
  }
  let builder;
  if (command === 'fund') {
    if (!/^[1-9][0-9]*$/.test(process.argv[3] || '')) throw new Error('A positive integer lovelace amount is required.');
    const { pool, scripts } = await verify(ctx, deployment);
    builder = buildMarketAction(ctx.lucid, t, scripts, ctx.address, { kind: 'deposit', amount: BigInt(process.argv[3]) }, pool);
  } else {
    const unit = process.argv[3];
    if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit || '')) throw new Error('A valid exact asset unit is required.');
    if (ctx.teamKey !== deployment.registry.issuer) throw new Error('Registry issuer wallet required.');
    const scripts = deploymentScripts(ctx.code, deployment), state = await ctx.lucid.utxoByUnit(deployment.registry.token);
    if (state.address !== scripts.registryAddress || state.address !== deployment.registry.address || !state.datum) throw new Error('Registry deployment mismatch.');
    const before = t.Data.from(state.datum);
    if (!(before instanceof t.Constr) || before.index !== 0 || before.fields.length !== 2 || !Array.isArray(before.fields[1])) throw new Error('Invalid registry datum.');
    const item = new t.Constr(0, [unit.slice(0, 56), unit.slice(56)]);
    if (before.fields[1].some(entry => t.Data.to(entry) === t.Data.to(item))) throw new Error('Asset is already registered.');
    const next = new t.Constr(0, [before.fields[0] + 1n, [item, ...before.fields[1]]]);
    builder = ctx.lucid.newTx().collectFrom([state], t.Data.to(new t.Constr(0, [item]))).attach.SpendingValidator(scripts.registry)
      .pay.ToContract(state.address, { kind: 'inline', value: t.Data.to(next) }, state.assets).addSigner(ctx.address);
  }
  const signed = await (await builder.complete()).sign.withWallet().complete();
  console.log(`${command}: ${signed.toHash()}`);
  await signed.submit();
  await ctx.lucid.awaitTxConfirmation(signed.toHash(), { timeout: 120_000, checkInterval: 3_000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
