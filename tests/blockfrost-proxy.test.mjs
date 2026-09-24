import assert from "node:assert/strict";
import test from "node:test";
import { Blockfrost } from "@lucid-evolution/provider";
import { blockfrostPostLimit, blockfrostQuery, isAllowedBlockfrostRequest } from "../src/lib/blockfrost-allowlist.ts";

const hash = "ab".repeat(32), unit = "cd".repeat(28) + "4e4654", address = "addr_test1qz" + "x".repeat(50);
const allowed = (method, path) => isAllowedBlockfrostRequest(method, path.split("/"));

test("app and Lucid read endpoints are allowed", () => {
  for (const path of ["epochs/latest/parameters", "network", `addresses/${address}/utxos`, `addresses/${address}/utxos/${unit}`, `addresses/${address}/transactions`,
    `assets/${unit}`, `assets/${unit}/addresses`, `assets/${unit}/metadata`, `scripts/${hash}`, `scripts/${hash}/cbor`, `scripts/${hash}/json`, `scripts/datum/${hash}/cbor`,
    `txs/${hash}`, `txs/${hash}/cbor`, `txs/${hash}/utxos`, `txs/${hash}/metadata`, `txs/${hash}/mints`, `txs/${hash}/redeemers`, "accounts/stake_test1uabc"]) assert.equal(allowed("GET", path), true, path);
});

test("only submit and evaluate accept POST", () => {
  for (const path of ["tx/submit", "utils/txs/evaluate", "utils/txs/evaluate/utxos"]) assert.equal(allowed("POST", path), true, path);
  for (const path of [`txs/${hash}`, "epochs/latest/parameters", "ipfs/add", "constructor", "toString"]) assert.equal(allowed("POST", path), false, path);
  assert.equal(allowed("GET", "tx/submit"), false);
  assert.equal(allowed("DELETE", `txs/${hash}`), false);
});

test("unlisted endpoints and unsafe segments are rejected", () => {
  for (const path of ["pools", "accounts", "epochs/latest", `txs/${hash}/extra/deep`, "ipfs/add", "metadata/txs/labels", "health"]) assert.equal(allowed("GET", path), false, path);
  for (const path of [["txs", ".."], ["txs", "..", "pools"], ["txs", ""], ["txs", "a/b"], ["txs", "a%2Fb"], ["txs", "a\\b"], ["assets", "a.b"], []]) assert.equal(isAllowedBlockfrostRequest("GET", path), false, JSON.stringify(path));
});

test("POST limits and query filtering", () => {
  assert.equal(blockfrostPostLimit(["tx", "submit"]), 64 * 1024);
  assert.equal(blockfrostPostLimit(["utils", "txs", "evaluate", "utxos"]), 256 * 1024);
  assert.equal(blockfrostPostLimit(["constructor"]), 0);
  assert.equal(blockfrostQuery(new URLSearchParams("order=desc&count=50&page=2")), "?order=desc&count=50&page=2");
  assert.equal(blockfrostQuery(new URLSearchParams("count=1&project_id=x&from=a/b")), "?count=1");
  assert.equal(blockfrostQuery(new URLSearchParams()), "");
});

test("every URL the Lucid Blockfrost provider requests passes the allowlist", async () => {
  const seen = [], original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { seen.push([init.method ?? "GET", String(url)]); return Response.json([]); };
  try {
    const provider = new Blockfrost("/api/blockfrost", "");
    const credential = { type: "Script", hash: "ef".repeat(28) };
    const calls = [() => provider.getProtocolParameters(), () => provider.getUtxos(address), () => provider.getUtxos(credential), () => provider.getUtxosWithUnit(address, unit),
      () => provider.getUtxoByUnit(unit), () => provider.getUtxosByOutRef([{ txHash: hash, outputIndex: 0 }]), () => provider.getDelegation("stake_test1uabc"),
      () => provider.getDatum(hash), () => provider.submitTx("84a0"), () => provider.evaluateTx("84a0")];
    for (const call of calls) await call().catch(() => {});
  } finally { globalThis.fetch = original; }
  assert.ok(seen.length >= 10);
  for (const [method, url] of seen) {
    const { pathname } = new URL(url, "http://local");
    assert.equal(isAllowedBlockfrostRequest(method, pathname.replace("/api/blockfrost/", "").split("/")), true, `${method} ${url}`);
  }
});
