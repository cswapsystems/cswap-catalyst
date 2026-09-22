import test from "node:test";
import assert from "node:assert/strict";
import * as tools from "@lucid-evolution/lucid";
import { validatePrices, instantSellQuote, priceUpdate, priceAda } from "../src/lib/price-book.ts";
import { verifyPriceSignature } from "../src/lib/price-book-auth.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const unit = "ab".repeat(28) + "01";
const entry = { unit, label: "Test asset", bid: "1500000", ask: "2000000", maxPerRequest: "5", maxInventory: "10", active: true };
const book = { revision: 1, entries: [entry], updatedAt: null, updatedBy: null };
test("Instant Sell quotes multiply per-base-unit prices exactly and honor both limits", () => {
  const quote = instantSellQuote(book, unit, 5n, 5n);
  assert.equal(quote.bid, 7_500_000n); assert.equal(quote.ask, 10_000_000n);
  assert.throws(() => instantSellQuote(book, unit, 6n, 0n), /per-request/);
  assert.throws(() => instantSellQuote(book, unit, 5n, 6n), /inventory cap/);
  assert.throws(() => instantSellQuote(book, unit, 0n, 0n), /per-request/);
});
test("inactive and unsupported assets cannot be acquired", () => {
  assert.throws(() => instantSellQuote({ ...book, entries: [{ ...entry, active: false }] }, unit, 1n, 0n), /not active/);
  assert.throws(() => instantSellQuote(book, "cd".repeat(28), 1n, 0n), /not active/);
});
test("price book rejects duplicate units, malformed identifiers, decimals and invalid limits", () => {
  assert.throws(() => validatePrices([entry, entry]), /only once/);
  for (const changed of [{ unit: unit + "f" }, { bid: "0" }, { bid: "1.5" }, { maxInventory: "2" }, { active: "true" }]) assert.throws(() => validatePrices([{ ...entry, ...changed }]));
});
test("editing prices does not lose lovelace precision above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(priceAda("9007199254740993123"), "9007199254740.993123");
});
test("price publishing verifies operator signature, payload and network", async () => {
  const privateKey = tools.generatePrivateKey();
  const key = tools.CML.PrivateKey.from_bech32(privateKey).to_public().hash().to_hex();
  const address = tools.credentialToAddress("Preprod", { type: "Key", hash: key });
  const update = priceUpdate(unit, 0, [entry], 123456);
  const signature = tools.signData(tools.getAddressDetails(address).address.hex, tools.fromText(JSON.stringify(update)), privateKey);
  assert.equal(await verifyPriceSignature(address, signature, update, key), true);
  assert.equal(await verifyPriceSignature(address, signature, { ...update, revision: 1 }, key), false);
  assert.equal(await verifyPriceSignature(address, signature, update, "ff".repeat(28)), false);
  assert.equal(await verifyPriceSignature(address, { key: "", signature: "" }, update, key), false);
  const mainnet = tools.credentialToAddress("Mainnet", { type: "Key", hash: key });
  const mainSignature = tools.signData(tools.getAddressDetails(mainnet).address.hex, tools.fromText(JSON.stringify(update)), privateKey);
  assert.equal(await verifyPriceSignature(mainnet, mainSignature, update, key), false);
});

test("development storage persists versions and rejects concurrent or stale writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cswap-price-test-"));
  const cwd = process.cwd(), environment = process.env.NODE_ENV, bucket = process.env.PRICE_BOOK_BUCKET;
  try {
    process.chdir(directory); process.env.NODE_ENV = "development"; delete process.env.PRICE_BOOK_BUCKET;
    const store = await import("../src/lib/server/price-book-store.ts");
    process.chdir(cwd);
    assert.equal((await store.readPriceBook()).book.revision, 0);
    const attempts = await Promise.allSettled([store.writePriceBook(book, 0), store.writePriceBook(book, 0)]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.deepEqual((await store.readPriceBook()).book, book);
    await assert.rejects(store.writePriceBook({ ...book, revision: 2 }, 0), /changed/);
    await store.writePriceBook({ ...book, revision: 2 }, 1);
    assert.equal((await store.readPriceBook()).book.revision, 2);
    process.env.NODE_ENV = "production";
    await assert.rejects(store.readPriceBook(), /Configure/);
  } finally {
    process.chdir(cwd);
    if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
    if (bucket === undefined) delete process.env.PRICE_BOOK_BUCKET; else process.env.PRICE_BOOK_BUCKET = bucket;
    await rm(directory, { recursive: true, force: true });
  }
});
