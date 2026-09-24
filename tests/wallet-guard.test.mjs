import assert from "node:assert/strict";
import test from "node:test";
import { assertWalletSession, isWalletChangedError, WALLET_CHANGED_MESSAGE } from "../src/lib/wallet-guard.ts";

const lucid = (address, network = "Preprod") => ({ wallet: () => ({ address: async () => { if (address instanceof Error) throw address; return address; } }), config: () => ({ network }) });

test("wallet guard accepts the same live Preprod account", async () => {
  await assertWalletSession(lucid("addr_test1a"), "addr_test1a");
});

test("wallet guard rejects a switched account", async () => {
  await assert.rejects(assertWalletSession(lucid("addr_test1b"), "addr_test1a"), (error) => isWalletChangedError(error) && error.message === WALLET_CHANGED_MESSAGE);
});

test("wallet guard rejects a non-Preprod network", async () => {
  await assert.rejects(assertWalletSession(lucid("addr_test1a", "Mainnet"), "addr_test1a"), isWalletChangedError);
  await assert.rejects(assertWalletSession(lucid("addr_test1a", "Preview"), "addr_test1a"), isWalletChangedError);
});

test("wallet guard rejects missing expected address and wallet read failures", async () => {
  await assert.rejects(assertWalletSession(lucid("addr_test1a"), ""), isWalletChangedError);
  await assert.rejects(assertWalletSession(lucid("addr_test1a"), null), isWalletChangedError);
  await assert.rejects(assertWalletSession(lucid(new Error("account changed")), "addr_test1a"), isWalletChangedError);
});

test("wallet guard re-reads the live account on every call", async () => {
  let current = "addr_test1a";
  const switching = { wallet: () => ({ address: async () => current }), config: () => ({ network: "Preprod" }) };
  await assertWalletSession(switching, "addr_test1a");
  current = "addr_test1b";
  await assert.rejects(assertWalletSession(switching, "addr_test1a"), isWalletChangedError);
});
