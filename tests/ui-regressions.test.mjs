import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "@lucid-evolution/lucid";
import { decodeCardanoAddress } from "../src/lib/address-codec.ts";
import { confirmTransaction } from "../src/lib/transaction-confirmation.ts";
import { scanOutputs } from "../src/lib/safe-scan.ts";
import { quoteLiquidityWithdrawal } from "../src/lib/dex.ts";

test("seller address decoding supports ordinary staked and enterprise wallets", () => {
  const pay = "aa".repeat(28), stake = "bb".repeat(28);
  for (const staking of [null, { StakingHash: [{ PubKeyCredential: [stake] }] }]) {
    const datum = tools.Data.from(tools.Data.to({ addressCredential: { PubKeyCredential: [pay] }, addressStakingCredential: staking }, tools.AddressSchema));
    assert.equal(decodeCardanoAddress(datum, tools), tools.credentialToAddress("Preprod", { type: "Key", hash: pay }, staking ? { type: "Key", hash: stake } : undefined));
  }
});
test("confirmation uses a bounded provider call and preserves the submitted hash on timeout", async () => {
  const hash = "ab".repeat(32);
  await assert.rejects(confirmTransaction({ awaitTxConfirmation: async (received, options) => {
    assert.equal(received, hash); assert.equal(options.timeout, 60_000); throw new Error("timeout");
  } }, hash), (error) => error.message.includes(hash) && error.message.includes("does not mean"));
});
test("unrelated or malformed outputs cannot suppress valid positions", () => {
  const result = scanOutputs(["first", null, "broken", "second"], (value) => { if (value === "broken") throw new Error("bad datum"); return value; });
  assert.deepEqual(result, { items: ["first", "second"], skipped: 1 });
});
test("withdrawal preview refuses zero-sided outputs and reports the minimum burn", () => {
  assert.throws(() => quoteLiquidityWithdrawal(1n, 10_000_000n, 100n, 1_000_000n), /at least 10000 LP/);
  assert.deepEqual(quoteLiquidityWithdrawal(10_000n, 10_000_000n, 100n, 1_000_000n), { amountA: 100_000n, amountB: 1n, lp: 10_000n });
});
