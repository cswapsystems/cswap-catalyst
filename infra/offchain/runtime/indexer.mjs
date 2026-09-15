import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createBlockfrostClient } from "./blockfrost.mjs";
import { decodeRegistryDatum } from "./cbor.mjs";
import { parseWatchedAddresses, requireEnvironment } from "./config.mjs";
import { createStore } from "./store.mjs";

function utxoReference(utxo) { return `${utxo.tx_hash}#${utxo.output_index}`; }

export function toStateItem(network, watched, utxo, indexedAt, tip) {
  const ref = utxoReference(utxo);
  return {
    PK: `UTXO#${ref}`, SK: "STATE", GSI1PK: `KIND#${watched.kind}`, GSI1SK: `UTXO#${ref}`,
    entity: "chain-state", kind: watched.kind, network, address: watched.address, reference: ref,
    txHash: utxo.tx_hash, outputIndex: utxo.output_index, amount: utxo.amount || [], datumHash: utxo.data_hash || null,
    inlineDatum: utxo.inline_datum || null, referenceScriptHash: utxo.reference_script_hash || null,
    tipSlot: tip.slot, tipHash: tip.hash, indexedAt,
  };
}

function supportedAssetsFrom(utxos) {
  const datum = utxos.find((utxo) => utxo.inline_datum)?.inline_datum;
  return datum ? decodeRegistryDatum(datum) : { version: "0", assets: [] };
}

async function reconcile(store, network, watched, utxos, indexedAt, tip) {
  const current = new Map(utxos.map((utxo) => [utxoReference(utxo), toStateItem(network, watched, utxo, indexedAt, tip)]));
  const existing = await store.queryKind(watched.kind);
  const requests = [];
  for (const item of existing.items.filter((item) => item.address === watched.address)) {
    if (!current.has(item.reference)) requests.push({ DeleteRequest: { Key: { PK: item.PK, SK: item.SK } } });
  }
  for (const item of current.values()) requests.push({ PutRequest: { Item: item } });
  await store.batchWrite(requests);
  return { current: current.size, deleted: requests.filter((item) => item.DeleteRequest).length };
}

async function reconcileRegistry(store, network, utxos, indexedAt, tip) {
  const registry = supportedAssetsFrom(utxos);
  const existing = await store.queryPartition("REGISTRY#SUPPORTED");
  const desired = new Set(registry.assets);
  const requests = [];
  for (const item of existing.items) if (!desired.has(item.unit)) requests.push({ DeleteRequest: { Key: { PK: item.PK, SK: item.SK } } });
  for (const unit of registry.assets) requests.push({ PutRequest: { Item: {
    PK: "REGISTRY#SUPPORTED", SK: `ASSET#${unit}`, GSI1PK: "KIND#supported-asset", GSI1SK: `ASSET#${unit}`,
    entity: "supported-asset", network, unit, registryVersion: registry.version, tipSlot: tip.slot, tipHash: tip.hash, indexedAt,
  } } });
  await store.batchWrite(requests);
  return registry.assets.length;
}

export function createIndexer({ store, blockfrost, watchedAddresses, network, now = () => new Date().toISOString() }) {
  return async function run() {
    const lockOwner = crypto.randomUUID();
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (store.acquireLock && !(await store.acquireLock(`${network}-indexer`, lockOwner, nowEpoch, nowEpoch + 110))) {
      return { network, skipped: true, reason: "Indexer invocation already active." };
    }
    try {
      const tip = await blockfrost.latestBlock();
      const previous = await store.get(`NETWORK#${network}`, "CHECKPOINT");
      const rollbackDetected = Boolean(previous && (tip.slot < previous.tipSlot || (tip.height === previous.tipHeight && tip.hash !== previous.tipHash)));
      const indexedAt = now();
      const results = [];
      for (const watched of watchedAddresses) {
        const utxos = await blockfrost.addressUtxos(watched.address);
        const result = await reconcile(store, network, watched, utxos, indexedAt, tip);
        if (watched.kind === "registry") result.supportedAssets = await reconcileRegistry(store, network, utxos, indexedAt, tip);
        results.push({ ...watched, ...result });
      }
      await store.put({ PK: `NETWORK#${network}`, SK: "CHECKPOINT", entity: "checkpoint", network,
        tipSlot: tip.slot, tipHeight: tip.height, tipHash: tip.hash, indexedAt, rollbackDetected, watched: results });
      return { network, tip: { slot: tip.slot, height: tip.height, hash: tip.hash }, rollbackDetected, watched: results };
    } finally {
      if (store.releaseLock) await store.releaseLock(`${network}-indexer`, lockOwner);
    }
  };
}

let secret;
async function projectId() {
  if (secret) return secret;
  const response = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: requireEnvironment("BLOCKFROST_SECRET_ARN") }));
  const parsed = JSON.parse(response.SecretString || "{}");
  if (!parsed.projectId || parsed.projectId === "UNCONFIGURED") throw new Error("Blockfrost secret is not configured.");
  secret = parsed.projectId;
  return secret;
}

export async function handler() {
  const network = requireEnvironment("CARDANO_NETWORK");
  return createIndexer({ store: createStore(), blockfrost: createBlockfrostClient({ network, projectId: await projectId() }), watchedAddresses: parseWatchedAddresses(), network })();
}
