import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "@lucid-evolution/lucid";
import { decodeCardanoAddress } from "../src/lib/address-codec.ts";
import { confirmTransaction } from "../src/lib/transaction-confirmation.ts";
import { scanOutputs } from "../src/lib/safe-scan.ts";
import { quoteLiquidityWithdrawal } from "../src/lib/dex.ts";
import { gatewayHeaders, sniffGatewayMedia } from "../src/lib/ipfs-content.ts";

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

test("IPFS gateway serves images, PDFs and valid JSON inline, never upstream HTML/SVG", () => {
  const bytes = (text) => new TextEncoder().encode(text);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.deepEqual(sniffGatewayMedia(png), { type: "image/png", inline: true });
  assert.equal(sniffGatewayMedia(bytes("RIFF\0\0\0\0WEBPVP8 "))?.type, "image/webp");
  const pdf = gatewayHeaders("bafyexample", sniffGatewayMedia(bytes("%PDF-1.7")));
  assert.equal(pdf["content-type"], "application/pdf");
  assert.equal(pdf["content-disposition"], "inline");
  const json = gatewayHeaders("bafyexample", sniffGatewayMedia(bytes("{\"name\":\"x\"}")));
  assert.equal(json["content-type"], "application/json; charset=utf-8");
  assert.equal(json["content-disposition"], "inline");
  for (const hostile of ["<!doctype html><script>alert(1)</script>", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "{\"name\":", "1"]) {
    assert.equal(sniffGatewayMedia(bytes(hostile)), null);
    const headers = gatewayHeaders("bafyexample", null);
    assert.equal(headers["content-type"], "application/octet-stream");
    assert.match(headers["content-disposition"], /^attachment/);
  }
  const image = gatewayHeaders("bafyexample", sniffGatewayMedia(png));
  assert.equal(image["x-content-type-options"], "nosniff");
  assert.match(image["content-security-policy"], /sandbox/);
  assert.equal(image["content-disposition"], "inline");
});
