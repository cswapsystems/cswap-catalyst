import assert from "node:assert/strict";
import test from "node:test";
import { parseAdaToLovelace, quoteConstantProduct } from "../src/lib/dex.ts";

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
