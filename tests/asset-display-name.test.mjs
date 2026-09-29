import test from "node:test";
import assert from "node:assert/strict";
import { assetDisplayName, cachedAssetName, loadAssetNames, metadataDisplayName, rememberAssetName } from "../src/lib/asset-display-name.ts";

const unit = "a".repeat(56) + "414243";
const original = "b".repeat(56) + "444546";

test("browser name cache uses CIP-25 display names and avoids repeat provider requests", async () => {
  const oldWindow = globalThis.window;
  const oldFetch = globalThis.fetch;
  const entries = new Map();
  let requests = 0;
  globalThis.window = { localStorage: {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  } };
  globalThis.fetch = async () => {
    requests++;
    return { ok: true, json: async () => ({ onchain_metadata: { name: ["Aurora ", "Watch"] } }) };
  };
  try {
    assert.deepEqual(await loadAssetNames([unit, unit]), { [unit]: "Aurora Watch" });
    assert.equal(requests, 1);
    assert.equal(cachedAssetName(unit), "Aurora Watch");
    assert.deepEqual(await loadAssetNames([unit]), { [unit]: "Aurora Watch" });
    assert.equal(requests, 1);
    assert.equal(assetDisplayName(unit, "ABC", { [unit]: "Aurora Watch" }), "Aurora Watch");
    assert.equal(assetDisplayName(original, "DEF-F", { [unit]: "Aurora Watch" }, unit), "Aurora Watch fractions");
    assert.equal(assetDisplayName(original, "DEF-F", {}, unit), "DEF-F");
  } finally {
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
  }
});

test("malformed metadata names are ignored", () => {
  assert.equal(metadataDisplayName({ name: ["Clean", 12] }), "");
  assert.equal(metadataDisplayName({ name: "Bad\u0000Name" }), "");
  assert.equal(rememberAssetName(unit, { name: "  " }), "");
});
