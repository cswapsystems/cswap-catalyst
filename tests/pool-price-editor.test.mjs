import assert from "node:assert/strict";
import test from "node:test";
import { changedPriceUnits, displayQuoteAmount, eligibleRegistryUnits, makePoolPrice, parseQuoteAmount, positiveBaseUnits, samePoolPrice } from "../src/lib/pool-price-editor.ts";

const unit = "ab".repeat(28) + "74657374";

test("ADA display amounts become exact lovelace ratios for asset quantities", () => {
  const price = makePoolPrice(unit, "0.5", "1", "1.25", "2", true);
  assert.deepEqual(price.buy, { numerator: 500_000n, denominator: 1n });
  assert.deepEqual(price.sell, { numerator: 1_250_000n, denominator: 2n });
  assert.equal(displayQuoteAmount(price.sell.numerator, true), "1.25");
  assert.equal(price.buy.numerator * 3n / price.buy.denominator, 1_500_000n);
});

test("native quote inputs remain integer base units and preserve fractional per-unit prices", () => {
  const price = makePoolPrice(unit, "1", "100", "3", "100", false);
  assert.equal(price.buy.numerator * 50n / price.buy.denominator, 0n);
  assert.equal(price.buy.numerator * 100n / price.buy.denominator, 1n);
  assert.equal(displayQuoteAmount(price.sell.numerator, false), "3");
  assert(samePoolPrice(price, { ...price, asset: { ...price.asset } }));
  assert(!samePoolPrice(price, { ...price, sell: { ...price.sell, numerator: 4n } }));
});

test("invalid units, nonpositive amounts, and excess ADA precision are rejected", () => {
  assert.equal(parseQuoteAmount("1.5", true), 1_500_000n);
  assert.equal(parseQuoteAmount("0.000001", true), 1n);
  assert.throws(() => makePoolPrice("bad", "1", "1", "2", "1", true), /approved asset/);
  assert.throws(() => parseQuoteAmount("0", true), /greater than zero/);
  assert.throws(() => parseQuoteAmount("0.0000001", true), /six decimal places/);
  assert.throws(() => parseQuoteAmount("1.5", false), /positive whole/);
  assert.throws(() => positiveBaseUnits("0", "Quantity"), /positive whole/);
});

test("registry selection excludes the pool quote and only changed prices need approval recheck", () => {
  const old = makePoolPrice(unit, "1", "1", "2", "1", true);
  const otherUnit = "cd".repeat(28) + "01";
  const other = makePoolPrice(otherUnit, "3", "1", "4", "1", true);
  assert.deepEqual(eligibleRegistryUnits([unit, otherUnit], otherUnit), [unit]);
  assert.deepEqual(changedPriceUnits([old, other], [old]), []); // Removal is allowed without a registry read.
  assert.deepEqual(changedPriceUnits([old], [old, other]), [otherUnit]);
  assert.deepEqual(changedPriceUnits([old], [{ ...old, buy: { ...old.buy, numerator: 2_000_000n } }]), [unit]);
});
