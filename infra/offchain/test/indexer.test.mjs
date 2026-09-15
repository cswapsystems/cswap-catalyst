import test from "node:test";
import assert from "node:assert/strict";
import { createIndexer } from "../runtime/indexer.mjs";

test("reconciles current state and records a rollback-aware checkpoint", async () => {
  const writes = [];
  const batches = [];
  const store = {
    get: async () => ({ tipSlot: 101, tipHeight: 10, tipHash: "old" }),
    queryKind: async () => ({ items: [{ PK: "UTXO#gone#0", SK: "STATE", address: "addr_test1watched", reference: "gone#0" }] }),
    queryPartition: async () => ({ items: [] }),
    batchWrite: async (items) => batches.push(...items),
    put: async (item) => writes.push(item),
  };
  const blockfrost = {
    latestBlock: async () => ({ slot: 100, height: 10, hash: "new" }),
    addressUtxos: async () => [{ tx_hash: "live", output_index: 1, amount: [{ unit: "lovelace", quantity: "2000000" }] }],
  };
  const run = createIndexer({ store, blockfrost, watchedAddresses: [{ kind: "dex-pool", address: "addr_test1watched" }], network: "preprod", now: () => "2026-09-15T00:00:00.000Z" });
  const result = await run();
  assert.equal(result.rollbackDetected, true);
  assert.equal(batches.filter((item) => item.DeleteRequest).length, 1);
  assert.equal(batches.filter((item) => item.PutRequest).length, 1);
  assert.equal(writes[0].rollbackDetected, true);
});
