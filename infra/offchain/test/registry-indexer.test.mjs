import test from "node:test";
import assert from "node:assert/strict";
import { createIndexer } from "../runtime/indexer.mjs";
import { parseWatchedAddresses } from "../runtime/config.mjs";
import { createApiHandler } from "../runtime/api.mjs";

const address = "addr_test1registry";
const token = `${"87".repeat(28)}43535741505f5245474953545259`;
const policy = "ab".repeat(28);
const unitA = `${policy}01`;
const unitB = `${policy}02`;

function head(major, value) {
  if (value < 24) return (major << 5 | value).toString(16).padStart(2, "0");
  if (value < 256) return (major << 5 | 24).toString(16) + value.toString(16).padStart(2, "0");
  return (major << 5 | 25).toString(16) + value.toString(16).padStart(4, "0");
}
const bytes = (hex) => head(2, hex.length / 2) + hex;
const constr0 = (...fields) => `d879${head(4, fields.length)}${fields.join("")}`;
function registryDatum(version, units) {
  return constr0(head(0, version), head(4, units.length) + units.map((unit) => constr0(bytes(unit.slice(0, 56)), bytes(unit.slice(56)))).join(""));
}

function utxo(txHash, datum, quantity = "1", extra = {}) {
  const amount = [{ unit: "lovelace", quantity: "3000000" }];
  if (quantity !== null) amount.push({ unit: token, quantity });
  return { tx_hash: txHash, output_index: 0, address, amount, inline_datum: datum, ...extra };
}

function memoryStore() {
  const items = new Map();
  const key = (PK, SK) => `${PK}|${SK}`;
  return {
    items,
    get: async (PK, SK) => items.get(key(PK, SK)),
    put: async (item) => { items.set(key(item.PK, item.SK), item); },
    batchWrite: async (requests) => {
      for (const request of requests) {
        if (request.PutRequest) items.set(key(request.PutRequest.Item.PK, request.PutRequest.Item.SK), request.PutRequest.Item);
        else items.delete(key(request.DeleteRequest.Key.PK, request.DeleteRequest.Key.SK));
      }
    },
    queryPartition: async (PK) => ({ items: [...items.values()].filter((item) => item.PK === PK) }),
    queryKind: async (kind) => ({ items: [...items.values()].filter((item) => item.GSI1PK === `KIND#${kind}`) }),
  };
}

const supported = (store) => [...store.items.values()].filter((item) => item.entity === "supported-asset").map((item) => item.unit).sort();
const status = (store) => store.items.get("REGISTRY#STATUS|STATUS");

function indexer(store, utxos, watched = { kind: "registry", address, token }) {
  return createIndexer({ store, network: "preprod", watchedAddresses: [watched], now: () => "2026-09-24T00:00:00.000Z",
    blockfrost: { latestBlock: async () => ({ slot: 1, height: 1, hash: "tip" }), addressUtxos: async () => utxos } });
}

async function seeded() {
  const store = memoryStore();
  await indexer(store, [utxo("real", registryDatum(1, [unitA]))])();
  assert.deepEqual(supported(store), [unitA]);
  return store;
}

test("config requires the registry identity token", () => {
  assert.throws(() => parseWatchedAddresses(JSON.stringify([{ kind: "registry", address }])), /identity token/);
  assert.deepEqual(parseWatchedAddresses(JSON.stringify([{ kind: "registry", address, token: token.toUpperCase() }, { kind: "vault", address, token }])),
    [{ kind: "registry", address, token }, { kind: "vault", address }]);
  assert.throws(() => parseWatchedAddresses(JSON.stringify([{ kind: "registry", address, token }, { kind: "registry", address: "addr_test1other", token }])), /Only one registry/);
});

test("R03 appendix: lovelace-only output with a registry datum does not become a supported asset", async () => {
  const writes = [];
  const puts = [];
  const store = {
    get: async () => null,
    queryKind: async () => ({ items: [] }),
    queryPartition: async () => ({ items: [] }),
    batchWrite: async (items) => writes.push(...items),
    put: async (item) => puts.push(item),
  };
  const run = createIndexer({ store, network: "preprod", watchedAddresses: [{ kind: "registry", address: "addr_test1review", token }],
    blockfrost: {
      latestBlock: async () => ({ slot: 1, height: 1, hash: "review" }),
      addressUtxos: async () => [{ tx_hash: "forged", output_index: 0, amount: [{ unit: "lovelace", quantity: "3000000" }], inline_datum: registryDatum(999, [unitA]) }],
    } });
  const result = await run();
  assert.equal(writes.some((w) => w.PutRequest?.Item.entity === "supported-asset"), false);
  assert.equal(result.watched[0].registry.state, "failed");
  assert.equal(puts.find((item) => item.entity === "registry-status").state, "failed");
});

test("forged output before the real one is ignored", async () => {
  const store = memoryStore();
  await indexer(store, [utxo("forged", registryDatum(999, [unitB]), null), utxo("real", registryDatum(1, [unitA]))])();
  assert.deepEqual(supported(store), [unitA]);
  assert.equal(status(store).state, "synced");
  assert.equal(status(store).registryReference, "real#0");
});

test("malformed output before the real one does not interrupt synchronization", async () => {
  const store = memoryStore();
  await indexer(store, [utxo("junk", "d87980ff", null), utxo("real", registryDatum(2, [unitA, unitB]))])();
  assert.deepEqual(supported(store), [unitA, unitB]);
  assert.equal(status(store).registryVersion, "2");
});

for (const [name, utxos, message] of [
  ["missing identity NFT", [utxo("forged", registryDatum(9, [unitB]), null)], /not found/],
  ["identity quantity 2", [utxo("real", registryDatum(9, [unitB]), "2")], /invalid quantity/],
  ["multiple authentic candidates", [utxo("a", registryDatum(9, [unitB])), utxo("b", registryDatum(9, [unitB]))], /2 outputs/],
  ["identity output at another address", [utxo("moved", registryDatum(9, [unitB]), "1", { address: "addr_test1elsewhere" })], /invalid quantity or address/],
  ["authentic output with malformed datum", [utxo("real", "d8799f00")], /Truncated|Invalid/],
  ["authentic output without inline datum", [utxo("real", null, "1", { data_hash: "ff".repeat(32) })], /no inline datum/],
  ["authentic output with duplicate entries", [utxo("real", registryDatum(9, [unitB, unitB]))], /Duplicate/],
]) {
  test(`${name} fails without replacing the last good registry`, async () => {
    const store = await seeded();
    const result = await indexer(store, utxos)();
    assert.deepEqual(supported(store), [unitA]);
    assert.equal(result.watched[0].registry.state, "failed");
    assert.match(status(store).error, message);
    assert.equal(status(store).state, "failed");
    assert.equal(status(store).registryVersion, "1");
    assert.equal(status(store).lastSyncedAt, "2026-09-24T00:00:00.000Z");
  });
}

test("registry update replaces the supported set and recovers from failure", async () => {
  const store = await seeded();
  await indexer(store, [])();
  assert.equal(status(store).state, "failed");
  await indexer(store, [utxo("next", registryDatum(2, [unitB]))])();
  assert.deepEqual(supported(store), [unitB]);
  assert.deepEqual({ state: status(store).state, error: status(store).error, version: status(store).registryVersion }, { state: "synced", error: null, version: "2" });
  assert.ok([...store.items.values()].filter((item) => item.entity === "supported-asset").every((item) => item.registryVersion === "2"));
});

test("an authenticated empty registry clears assets and reports synced", async () => {
  const store = await seeded();
  await indexer(store, [utxo("empty", registryDatum(3, []))])();
  assert.deepEqual(supported(store), []);
  assert.equal(status(store).state, "synced");
  assert.equal(status(store).assetCount, 0);
});

test("rejects a registry address from the wrong network", async () => {
  const store = memoryStore();
  const result = await createIndexer({ store, network: "mainnet", watchedAddresses: [{ kind: "registry", address, token }], now: () => "t",
    blockfrost: { latestBlock: async () => ({ slot: 1, height: 1, hash: "tip" }), addressUtxos: async () => [utxo("real", registryDatum(1, [unitA]))] } })();
  assert.equal(result.watched[0].registry.state, "failed");
  assert.deepEqual(supported(store), []);
});

test("API distinguishes failed, empty and unavailable registry state", async () => {
  const request = { rawPath: "/v1/registry/assets", requestContext: { http: { method: "GET" } } };
  const empty = memoryStore();
  let body = JSON.parse((await createApiHandler({ store: empty, network: "preprod" })(request)).body);
  assert.deepEqual(body.registry, { state: "unavailable" });
  await indexer(empty, [utxo("empty", registryDatum(1, []))])();
  body = JSON.parse((await createApiHandler({ store: empty, network: "preprod" })(request)).body);
  assert.equal(body.registry.state, "synced");
  assert.equal(body.count, 0);
  const store = await seeded();
  await indexer(store, [utxo("forged", registryDatum(9, [unitB]), null)])();
  body = JSON.parse((await createApiHandler({ store, network: "preprod" })(request)).body);
  assert.equal(body.registry.state, "failed");
  assert.equal(body.registry.PK, undefined);
  assert.deepEqual(body.items.map((item) => item.unit), [unitA]);
});
