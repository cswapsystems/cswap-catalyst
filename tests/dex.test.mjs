import assert from "node:assert/strict";
import test from "node:test";
import { parseAdaToLovelace, quoteConstantProduct, quoteLiquidityDeposit, quoteLiquidityWithdrawal, priceImpactBps } from "../src/lib/dex.ts";

test("parses ADA amounts exactly into lovelace", () => {
  assert.equal(parseAdaToLovelace("12.345678"), 12_345_678n);
  assert.equal(parseAdaToLovelace("1"), 1_000_000n);
  assert.throws(() => parseAdaToLovelace("0"), /greater than zero/);
  assert.throws(() => parseAdaToLovelace("1.0000001"), /six decimal/);
});

test("quotes a fee-adjusted constant-product swap with integer rounding", () => {
  assert.equal(quoteConstantProduct(10_000_000n, 100_000_000n, 1_000n, 997n, 1_000n), 90n);
  assert.throws(() => quoteConstantProduct(1n, 100_000_000n, 1_000n, 997n, 1_000n), /rounds to zero/);
});

test("deposit preview preserves the exact reserve ratio and reveals rounding up", () => {
  const quote = quoteLiquidityDeposit(11n, 100n, 30n, 1_000n);
  assert.deepEqual(quote, { amountA: 20n, amountB: 6n, lp: 200n });
  assert.equal(quote.amountA * 30n, quote.amountB * 100n);
  assert.throws(() => quoteLiquidityDeposit(0n, 100n, 30n, 1_000n), /positive/);
  assert.throws(() => quoteLiquidityDeposit(1n, 1_000_000n, 1_000_000n, 1n), /zero/);
});

test("withdrawal preview rounds down and excludes full-supply closure", () => {
  assert.deepEqual(quoteLiquidityWithdrawal(3n, 101n, 51n, 10n), { amountA: 30n, amountB: 15n, lp: 3n });
  assert.throws(() => quoteLiquidityWithdrawal(10n, 101n, 51n, 10n), /less than/);
  assert.throws(() => quoteLiquidityWithdrawal(-1n, 101n, 51n, 10n), /less than/);
});

test("impact compares actual output including fees with the spot rate", () => {
  assert.equal(priceImpactBps(10n, 90n, 100n, 1_000n), 1_000n);
  assert.equal(priceImpactBps(10n, 100n, 100n, 1_000n), 0n);
  assert.throws(() => priceImpactBps(0n, 0n, 100n, 1_000n), /positive/);
});

test("preview arithmetic remains exact above Number.MAX_SAFE_INTEGER", () => {
  const reserve = 10n ** 24n;
  const quote = quoteLiquidityDeposit(reserve, reserve * 2n, reserve, reserve * 10n);
  assert.equal(quote.amountA, reserve);
  assert.equal(quote.amountB, reserve / 2n);
  assert.equal(quote.lp, reserve * 5n);
});
