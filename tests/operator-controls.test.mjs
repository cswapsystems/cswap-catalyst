import assert from "node:assert/strict";
import test from "node:test";
import { sharedPoolUpdateFields, factoryPauseFields } from "../src/lib/operator-controls.ts";

test("shared-pool controls preserve identity, authorities, supply and open inventory", () => {
  const fields = ["admin", "batcher", "poolNFT", "lp", "receipt", "quote", ["prices"], 1_000n, 20n, false, 50n, 75n, 2n, null];
  const next = sharedPoolUpdateFields(fields, 30n, 100n, true);
  assert.deepEqual(next, ["admin", "batcher", "poolNFT", "lp", "receipt", "quote", ["prices"], 1_000n, 30n, true, 50n, 75n, 2n, null]);
  assert.equal(fields[8], 20n);
  assert.equal(fields[9], false);
  assert.throws(() => sharedPoolUpdateFields(fields, -1n, 100n, true), /between/);
  assert.throws(() => sharedPoolUpdateFields(fields, 101n, 100n, true), /between/);
  assert.throws(() => sharedPoolUpdateFields([], 20n, 100n, true), /Malformed/);
});

test("factory pause preserves pool sequence and factory identity", () => {
  const fields = ["factoryNFT", "admin", "policy", 42n, false];
  assert.deepEqual(factoryPauseFields(fields, true), ["factoryNFT", "admin", "policy", 42n, true]);
  assert.equal(fields[4], false);
  assert.throws(() => factoryPauseFields(["factoryNFT", "admin", "policy", "42", false], true), /Malformed/);
});
