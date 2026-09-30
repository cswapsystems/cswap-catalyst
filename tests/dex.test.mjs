import assert from "node:assert/strict";
import test from "node:test";
import { parseAdaToLovelace, quoteConstantProduct, quoteLiquidityDeposit, quoteLiquidityWithdrawal, priceImpactBps } from "../src/lib/dex.ts";
import { findSwapMarket, swapTargets, swapTokens } from "../src/lib/dex-swap.ts";
import { dexLpDisplayName, formatPoolSpotPrice } from "../src/lib/protocol/dex-client.ts";

const ada = { policyId: "", assetName: "" };
const tokenA = { policyId: "aa".repeat(28), assetName: "01" };
const tokenB = { policyId: "bb".repeat(28), assetName: "02" };
const nativeQuote = { policyId: "cc".repeat(28), assetName: "03" };
const unit = asset => asset.policyId ? asset.policyId + asset.assetName : "lovelace";
const markets = [{ id: "first", assetA: ada, assetB: tokenA }, { id: "second", assetA: ada, assetB: tokenB }, { id: "native", assetA: nativeQuote, assetB: tokenA }];

test("swap selectors deduplicate tokens and only expose direct counterparties", () => {
  assert.deepEqual(swapTokens(markets), [ada, tokenA, tokenB, nativeQuote]);
  assert.deepEqual(swapTargets(markets, unit(ada)), [tokenA, tokenB]);
  assert.deepEqual(swapTargets(markets, unit(tokenA)), [ada, nativeQuote]);
  assert.deepEqual(swapTargets(markets, "unknown"), []);
  assert.deepEqual(swapTokens([]), []);
});

test("From/To selection maps both directions to the correct validator action", () => {
  assert.deepEqual(findSwapMarket(markets, unit(ada), unit(tokenA)), { id: "first", action: "swap-a" });
  assert.deepEqual(findSwapMarket(markets, unit(tokenA), unit(ada)), { id: "first", action: "swap-b" });
  assert.deepEqual(findSwapMarket(markets, unit(tokenA), unit(nativeQuote)), { id: "native", action: "swap-b" });
  assert.equal(findSwapMarket(markets, unit(tokenA), unit(tokenB)), null);
  assert.equal(findSwapMarket(markets, unit(ada), unit(ada)), null);
  assert.equal(findSwapMarket([], unit(ada)), null);
});

test("pair selection preserves a preferred pool and falls back to a supported market", () => {
  const duplicate = { ...markets[0], id: "duplicate" };
  assert.deepEqual(findSwapMarket([...markets, duplicate], unit(ada), unit(tokenA), "duplicate"), { id: "duplicate", action: "swap-a" });
  assert.deepEqual(findSwapMarket(markets, unit(tokenB)), { id: "second", action: "swap-b" });
});

test("DEX LP labels identify the underlying pair instead of the binary pool ID", () => {
  const label = asset => asset === tokenA ? "FRACTION A" : asset === nativeQuote ? "USDCx" : "Unknown";
  assert.equal(dexLpDisplayName(ada, tokenA, label), "FRACTION A - ADA LP");
  assert.equal(dexLpDisplayName(nativeQuote, tokenA, label), "FRACTION A - USDCx LP");
});

test("pool spot prices normalize lovelace and retain exact reserve ratios", () => {
  assert.equal(formatPoolSpotPrice(25_000_000n, 100n, true), "0.25");
  assert.equal(formatPoolSpotPrice(250_000n, 100n, false), "2,500");
  assert.equal(formatPoolSpotPrice(1n, 10_000_000n, true), "< 0.000001");
  assert.equal(formatPoolSpotPrice(0n, 100n, true), "Unavailable");
});

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
