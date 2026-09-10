import assert from "node:assert/strict";
import test from "node:test";
import { formatWalletAda, summarizeWalletAssets, walletAssetName } from "../src/lib/wallet-assets.ts";

const policy = "ab".repeat(28);

test("combines token balances across wallet outputs without losing integer precision", () => {
  const unit = policy + "546f6b656e";
  const otherUnit = "cd".repeat(28) + "546f6b656e";
  const huge = 9007199254740993n;
  const result = summarizeWalletAssets([
    { assets: { lovelace: 1234567n, [unit]: huge } },
    { assets: { lovelace: 2000000n, [unit]: 7n, [otherUnit]: 1n } },
  ]);
  assert.equal(result.lovelace, 3234567n);
  assert.equal(result.utxoCount, 2);
  assert.equal(result.assets.length, 2);
  assert.equal(result.assets.find((asset) => asset.unit === unit).quantity, huge + 7n);
  assert.equal(result.assets.find((asset) => asset.unit === otherUnit).quantity, 1n);
  assert.equal(result.assets[0].name, "Token");
});

test("empty and ADA-only wallets have no native token rows", () => {
  assert.deepEqual(summarizeWalletAssets([]), { lovelace: 0n, assets: [], utxoCount: 0 });
  assert.equal(summarizeWalletAssets([{ assets: { lovelace: 1000000n, [policy]: 0n } }]).assets.length, 0);
});

test("asset names support UTF-8 and safely label binary, empty, and control-byte names", () => {
  assert.equal(walletAssetName("546f6b656e"), "Token");
  assert.equal(walletAssetName("e4b8ad"), "中");
  assert.equal(walletAssetName(""), "Unnamed token");
  for (const value of ["ff", "00", "0a", "c280", "x1", "0"]) assert.equal(walletAssetName(value), "Binary asset name");
});

test("ADA formatting retains all six fractional digits and very large balances", () => {
  assert.equal(formatWalletAda(0n), "0");
  assert.equal(formatWalletAda(1n), "0.000001");
  assert.equal(formatWalletAda(1234500n), "1.2345");
  assert.equal(formatWalletAda(9007199254740993123456n), "9,007,199,254,740,993.123456");
});
