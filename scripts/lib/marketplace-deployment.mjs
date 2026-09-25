import * as t from '@lucid-evolution/lucid';
import { createHash } from 'node:crypto';
import { decodeSharedPool, marketAddressData, marketAssetData, marketUnit } from '../../src/lib/marketplace.ts';
import { decodeRegistryDatum } from '../../src/lib/asset-registry.ts';

export const referenceNames = ['orderbook', 'pool', 'lp', 'inventory'];
const asset = unit => ({ policyId: unit.slice(0, 56), assetName: unit.slice(56) });
const data = unit => marketAssetData(t, asset(unit));
const script = (code, title, params = []) => {
  if (!code[title]) throw new Error(`Missing blueprint validator: ${title}`);
  return { type: 'PlutusV3', script: params.length ? t.applyParamsToScript(code[title], params) : code[title] };
};
export const blueprintDigest = code => createHash('sha256').update(JSON.stringify(Object.entries(code).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

export function deploymentScripts(code, deployment) {
  const orderbook = script(code, 'marketplace_listing_escrow.marketplace_listing_escrow.spend');
  const orderbookAddress = t.validatorToAddress('Preprod', orderbook);
  const pool = script(code, 'shared_reserve_pool.shared_reserve_pool.spend', [marketAddressData(t, orderbookAddress)]);
  const lp = script(code, 'pool_share_policy.pool_share_policy.mint', [data(deployment.pool.token), deployment.pool.lpToken.slice(56)]);
  const inventory = script(code, 'pool_inventory_receipt_policy.pool_inventory_receipt_policy.mint', [data(deployment.pool.token), deployment.pool.inventoryToken.slice(56), deployment.batcher]);
  const registry = script(code, 'asset_registry.asset_registry.spend', [data(deployment.registry.token), deployment.registry.issuer]);
  return { orderbook, orderbookAddress, pool, poolAddress: t.validatorToAddress('Preprod', pool), lp, inventory, registry, registryAddress: t.validatorToAddress('Preprod', registry) };
}

// Burn-capable one_shot identity, rebuilt from the recorded seed. Deployments
// without a seed (or minted by an older one_shot) cannot complete closure.
export function poolIdentity(code, deployment) {
  const seed = deployment.pool.identitySeed;
  if (!seed) return undefined;
  const identity = script(code, 'one_shot.one_shot.mint', [new t.Constr(0, [seed.txHash, BigInt(seed.outputIndex)]), deployment.pool.token.slice(56)]);
  return t.mintingPolicyToId(identity) === deployment.pool.token.slice(0, 56) ? { script: identity, redeemer: t.Data.to(new t.Constr(0, [])) } : undefined;
}

export function initialPoolDatum(deployment) {
  return t.Data.to(new t.Constr(0, [deployment.team, deployment.batcher,
    data(deployment.pool.token), data(deployment.pool.lpToken), data(deployment.pool.inventoryToken), new t.Constr(0, ['', '']),
    [], 0n, BigInt(deployment.pool.minCashReserve), new t.Constr(0, []), 0n, 0n, 0n, new t.Constr(1, []),
  ]));
}

export function freshDeployment(code, previous, seed, teamKey, registrySnapshot) {
  if (previous.network !== 'preprod' || previous.team !== teamKey) throw new Error('Fresh deployment requires the configured Preprod Team wallet. Roles are preserved.');
  const name = t.fromText('CSWAP_QUOTE_POOL');
  const identity = script(code, 'one_shot.one_shot.mint', [new t.Constr(0, [seed.txHash, BigInt(seed.outputIndex)]), name]);
  const token = t.mintingPolicyToId(identity) + name;
  const lpName = t.fromText('CSWAP_POOL_LP'), inventoryName = t.fromText('CSWAP_INVENTORY');
  const deployment = {
    schemaVersion: 14, network: 'preprod', team: previous.team, batcher: previous.batcher,
    blueprintDigest: blueprintDigest(code), registry: { ...previous.registry },
    pool: { token, identitySeed: { txHash: seed.txHash, outputIndex: seed.outputIndex }, lpToken: '0'.repeat(56) + lpName, inventoryToken: '0'.repeat(56) + inventoryName, quoteUnit: 'lovelace', minCashReserve: '20000000' },
    referenceScripts: [], supersedes: previous,
  };
  let derived = deploymentScripts(code, deployment), registryIdentity;
  if (derived.registryAddress !== previous.registry.address) {
    if (!registrySnapshot) throw new Error('Registry blueprint has changed; review and authorize --replace-registry to copy its approved-asset list into a fresh registry.');
    if (previous.registry.issuer !== teamKey || registrySnapshot.address !== previous.registry.address || registrySnapshot.assets[previous.registry.token] !== 1n || !registrySnapshot.datum) throw new Error('Registry replacement requires its issuer and authenticated registry state.');
    decodeRegistryDatum(t, registrySnapshot.datum);
    const registryName = t.fromText('CSWAP_REGISTRY');
    registryIdentity = script(code, 'one_shot.one_shot.mint', [new t.Constr(0, [seed.txHash, BigInt(seed.outputIndex)]), registryName]);
    deployment.registry = { token: t.mintingPolicyToId(registryIdentity) + registryName, issuer: previous.registry.issuer,
      initialDatum: registrySnapshot.datum, copiedFrom: { txHash: registrySnapshot.txHash, outputIndex: registrySnapshot.outputIndex } };
    derived = deploymentScripts(code, deployment);
    deployment.registry.address = derived.registryAddress;
  }
  deployment.orderbookAddress = derived.orderbookAddress;
  deployment.pool.address = derived.poolAddress;
  deployment.pool.lpToken = t.mintingPolicyToId(derived.lp) + lpName;
  deployment.pool.inventoryToken = t.mintingPolicyToId(derived.inventory) + inventoryName;
  // Separate native-script address: ordinary wallet coin selection cannot spend references.
  // The Team retains recovery authority without locking deposits in the pool validator.
  const custody = t.scriptFromNative({ type: 'sig', keyHash: teamKey });
  deployment.referenceCustody = { address: t.validatorToAddress('Preprod', custody), script: custody };
  return { deployment, identity, registryIdentity, scripts: derived };
}

export function referenceOutput(lucid, deployment, reference) {
  const output = { address: deployment.referenceCustody.address, txHash: '00'.repeat(32), outputIndex: 0,
    datum: t.Data.to(0n), assets: { lovelace: 2_000_000n }, scriptRef: reference };
  const coins = lucid.config().protocolParameters?.coinsPerUtxoByte;
  if (!coins) throw new Error('Protocol parameters unavailable.');
  // Include a small buffer for differences in integer serialization size.
  output.assets.lovelace = t.calculateMinLovelaceFromUTxO(BigInt(coins), output) + 100_000n;
  return output;
}

export function bootstrapBuilder(lucid, deployment, identity, seed, registryIdentity) {
  let builder = lucid.newTx().collectFrom([seed])
    .mintAssets({ [deployment.pool.token]: 1n }, t.Data.to(new t.Constr(0, [])))
    .attach.MintingPolicy(identity)
    .pay.ToContract(deployment.pool.address, { kind: 'inline', value: initialPoolDatum(deployment) },
      { lovelace: BigInt(deployment.pool.minCashReserve), [deployment.pool.token]: 1n });
  if (registryIdentity) builder = builder.mintAssets({ [deployment.registry.token]: 1n }, t.Data.to(new t.Constr(0, [])))
    .attach.MintingPolicy(registryIdentity)
    .pay.ToContract(deployment.registry.address, { kind: 'inline', value: deployment.registry.initialDatum }, { lovelace: 5_000_000n, [deployment.registry.token]: 1n });
  return builder;
}

export function assertDeployment(code, deployment, poolUtxo, references) {
  const derived = deploymentScripts(code, deployment);
  if (deployment.network !== 'preprod' || derived.orderbookAddress !== deployment.orderbookAddress || derived.poolAddress !== deployment.pool.address || derived.registryAddress !== deployment.registry.address) throw new Error('Deployment addresses do not match the blueprint.');
  if (t.mintingPolicyToId(derived.lp) !== deployment.pool.lpToken.slice(0, 56) || t.mintingPolicyToId(derived.inventory) !== deployment.pool.inventoryToken.slice(0, 56)) throw new Error('Deployment policies do not match the blueprint.');
  if (poolUtxo.address !== deployment.pool.address) throw new Error('Pool identity is not at its configured address.');
  const pool = decodeSharedPool(t, poolUtxo);
  if (marketUnit(pool.poolToken) !== deployment.pool.token || pool.lpUnit !== deployment.pool.lpToken || marketUnit(pool.inventoryToken) !== deployment.pool.inventoryToken || marketUnit(pool.quote) !== deployment.pool.quoteUnit || pool.admin !== deployment.team || pool.batcher !== deployment.batcher) throw new Error('Pool datum does not match deployment identities/roles.');
  const hashes = references.map(ref => ref.scriptRef && t.validatorToScriptHash(ref.scriptRef));
  if (references.length !== 4 || referenceNames.some(name => !hashes.includes(t.validatorToScriptHash(derived[name])))) throw new Error('All four distinct marketplace reference scripts must be present.');
  return { pool, scripts: { ...derived, references, identity: poolIdentity(code, deployment) } };
}
