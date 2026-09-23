import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "@lucid-evolution/lucid";
import { createBrowserChainProvider, readProtocolParameters } from "../src/lib/browser-chain-provider.ts";

const valid = {
  protocol_major_ver: 10, protocol_minor_ver: 0, min_fee_a: 44, min_fee_b: 155381, max_tx_size: 16384, max_val_size: 5000,
  key_deposit: "2000000", pool_deposit: "500000000", drep_deposit: "500000000", gov_action_deposit: "1000000000",
  price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", coins_per_utxo_size: "4310",
  collateral_percent: 150, max_collateral_inputs: 3, min_fee_ref_script_cost_per_byte: 15,
  cost_models_raw: tools.PROTOCOL_PARAMETERS_DEFAULT.costModels,
};
const json = (value, status = 200) => async () => Response.json(value, {status});

test("validated provider initializes the real Lucid transaction builder", async () => {
  let calls = 0;
  const provider = createBrowserChainProvider(tools, "/api/blockfrost", async (url, options) => {
    assert.equal(url, "/api/blockfrost/epochs/latest/parameters");
    assert.equal(options.cache, "no-store");
    calls++;
    return Response.json(valid);
  });
  const lucid = await tools.Lucid(provider, "Preprod");
  assert.equal(calls, 1);
  assert.equal(lucid.config().protocolParameters.keyDeposit, 2000000n);
  assert.equal(lucid.config().protocolParameters.coinsPerUtxoByte, 4310n);
});

test("HTTP failures report actionable service errors, never BigInt(undefined)", async () => {
  for (const status of [401, 403, 404, 402, 429, 500, 503]) {
    await assert.rejects(readProtocolParameters("/api/blockfrost", json({error:"private upstream details"}, status)), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /BigInt|private upstream details/);
      return true;
    });
  }
});

test("error documents, missing fields, nulls, bad numbers and cost models fail closed", async () => {
  for (const body of [{error:"Forbidden"}, null, [], {...valid, key_deposit: undefined}, {...valid, drep_deposit: null}, {...valid, coins_per_utxo_size: ""}, {...valid, max_tx_ex_steps: 1.5}, {...valid, min_fee_a: "bad"}, {...valid, cost_models_raw: {}}]) {
    await assert.rejects(readProtocolParameters("/api/blockfrost", json(body)), /chain API returned/);
  }
});

test("non-JSON responses and network errors have clear connection messages", async () => {
  await assert.rejects(readProtocolParameters("/api/blockfrost", async () => new Response("<html>error</html>")), /API routing/);
  await assert.rejects(readProtocolParameters("/api/blockfrost", async () => {throw new Error("fetch failed");}), /Cannot reach the Preprod chain service/);
});
