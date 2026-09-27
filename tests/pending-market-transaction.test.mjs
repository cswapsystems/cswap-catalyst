import assert from "node:assert/strict";
import test from "node:test";
import { clearPendingMarket, pendingMarketKey, readPendingMarket, savePendingMarket } from "../src/lib/pending-market-transaction.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
const wallet = "addr_test1walletone";
const other = "addr_test1wallettwo";
const transaction = { version: 1, network: "preprod", wallet, operation: "instant sell acquisition", hash: "ab".repeat(32), submittedAt: 1_700_000_000_000 };

test("submitted Marketplace hash survives a reload and is wallet scoped", () => {
  const storage = memoryStorage();
  assert.deepEqual(readPendingMarket(storage, wallet), { kind: "empty" });
  savePendingMarket(storage, transaction);
  assert.deepEqual(readPendingMarket(storage, wallet), { kind: "pending", transaction });
  savePendingMarket(storage, { ...transaction, operation: "shared reserve or LP update" });
  assert.equal(readPendingMarket(storage, wallet).kind, "pending");
  savePendingMarket(storage, transaction);
  assert.deepEqual(readPendingMarket(storage, other), { kind: "empty" });
  assert.throws(() => savePendingMarket(storage, { ...transaction, hash: "cd".repeat(32) }), /awaiting confirmation/);
  assert.throws(() => clearPendingMarket(storage, wallet, "cd".repeat(32)), /different transaction/);
  assert.deepEqual(readPendingMarket(storage, wallet), { kind: "pending", transaction });
  clearPendingMarket(storage, wallet, transaction.hash);
  assert.deepEqual(readPendingMarket(storage, wallet), { kind: "empty" });
});

test("corrupt, cross-network and cross-wallet records block signing", () => {
  const storage = memoryStorage();
  for (const invalid of ["{", JSON.stringify({ ...transaction, network: "mainnet" }), JSON.stringify({ ...transaction, wallet: other }), JSON.stringify({ ...transaction, hash: "invalid" })]) {
    storage.setItem(pendingMarketKey(wallet), invalid);
    assert.equal(readPendingMarket(storage, wallet).kind, "unavailable");
    assert.throws(() => savePendingMarket(storage, transaction), /invalid/);
  }
});

test("unavailable storage fails closed before signing", () => {
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readPendingMarket(storage, wallet).kind, "unavailable");
  assert.throws(() => savePendingMarket(storage, transaction), /unavailable/);
});
