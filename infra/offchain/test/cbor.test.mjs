import test from "node:test";
import assert from "node:assert/strict";
import { decodeRegistryDatum } from "../runtime/cbor.mjs";

test("decodes a registry datum into canonical asset units", () => {
  const policy = "11".repeat(28);
  const datum = `d8799f019fd8799f581c${policy}43414243ffffff`;
  assert.deepEqual(decodeRegistryDatum(datum), { version: "1", assets: [policy + "414243"] });
});

test("rejects a policy id that is not 28 bytes", () => {
  assert.throws(() => decodeRegistryDatum("d8799f009fd8799f41114141ffffff"), /Invalid registry asset/);
});

test("rejects registry datums outside the on-chain schema", () => {
  const policy = "11".repeat(28);
  const entry = `d8799f581c${policy}41aaff`;
  assert.throws(() => decodeRegistryDatum(`d8799f209f${entry}ffff`), /Invalid registry datum/);
  assert.throws(() => decodeRegistryDatum(`d87a9f019f${entry}ffff`), /Invalid registry datum/);
  assert.throws(() => decodeRegistryDatum(`d8799f019fd8799f581c${policy}5821${"aa".repeat(33)}ffffff`), /Invalid registry asset/);
  assert.throws(() => decodeRegistryDatum(`d8799f019f${entry}${entry}ffff`), /Duplicate registry entries/);
});
