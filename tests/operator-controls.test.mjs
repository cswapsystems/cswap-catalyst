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

test("protected reserve rejects ADA-quoted values below 2 ADA", async () => {
  const { parseProtectedReserve, MIN_ADA_PROTECTED_RESERVE } = await import("../src/lib/operator-controls.ts");
  assert.equal(parseProtectedReserve("2", false), MIN_ADA_PROTECTED_RESERVE);
  assert.equal(parseProtectedReserve("10.5", false), 10_500_000n);
  for (const value of ["0", "0.000000", "1.999999", "1"]) assert.throws(() => parseProtectedReserve(value, false), /at least 2 ADA/);
  assert.throws(() => parseProtectedReserve("abc", false), /six decimal places/);
  assert.equal(parseProtectedReserve("0", true), 0n);
  assert.equal(parseProtectedReserve("25", true), 25n);
  assert.throws(() => parseProtectedReserve("1.5", true), /whole quote-asset base units/);
});
