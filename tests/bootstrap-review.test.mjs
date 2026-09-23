import assert from "node:assert/strict";
import test from "node:test";
import { reviewBootstrapPlan } from "../src/lib/bootstrap-review.ts";

const offer = { id: "offer#0", owner: "addr_test1owner", ownerKey: "owner", factoryToken: { policyId: "f".repeat(56), assetName: "factory" }, fraction: { policyId: "a".repeat(56), assetName: "fraction" }, fractionAmount: 1_000n, quote: { policyId: "", assetName: "" }, quoteAmount: 10_000_000n, poolLovelace: 2_000_000n, ownerShareBps: 5_000n };
const deployment = { admin: "team", factoryAddress: "addr_test1factory", ammAddress: "addr_test1amm", lpPolicyId: "l".repeat(56), poolPolicyId: "p".repeat(56) };
function plan(overrides = {}) {
  const poolName = "0000000000000000", poolNft = deployment.poolPolicyId + poolName, lp = deployment.lpPolicyId + poolName, liquidity = 100_000n;
  return { offer, factory: { id: "factory#0", nextPoolId: 0n }, deployment, provider: { address: "addr_test1provider", key: "provider" }, transaction: { inputs: ["offer#0", "factory#0", "provider#0"], teamWalletInputs: [], requiredSigners: ["provider", "team"], mint: { [poolNft]: "1", [lp]: liquidity.toString() }, withdrawals: 0, certificates: 0, pool: { address: deployment.ammAddress, assets: { lovelace: "10000000", [offer.fraction.policyId + offer.fraction.assetName]: "1000", [poolNft]: "1" }, datum: { poolNft: { policyId: deployment.poolPolicyId, assetName: poolName }, assetA: offer.quote, assetB: offer.fraction, lpToken: { policyId: deployment.lpPolicyId, assetName: poolName }, feeN: 997n, feeD: 1_000n, reserveA: offer.quoteAmount, reserveB: offer.fractionAmount, liquidity, poolLovelace: offer.quoteAmount } }, lpPaid: { [offer.owner]: 50_000n, "addr_test1provider": 50_000n }, ...overrides } };
}

test("accepts an exact three-party bootstrap plan", () => {
  assert.deepEqual(reviewBootstrapPlan(plan()), { ok: true, issues: [], poolName: "0000000000000000", ownerLp: 50_000n, providerLp: 50_000n });
});
test("rejects Team-wallet inputs and unrelated minting", () => {
  const result = reviewBootstrapPlan(plan({ teamWalletInputs: ["team#0"], mint: { ["p".repeat(56) + "0000000000000000"]: "1", ["l".repeat(56) + "0000000000000000"]: "100000", ["x".repeat(56) + "extra"]: "1" } }));
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /Team-wallet UTxO/);
  assert.match(result.issues.join(" "), /mints assets other/);
});
test("rejects a changed pool destination, reserve, or signer set", () => {
  const result = reviewBootstrapPlan(plan({ requiredSigners: ["team"], pool: { ...plan().transaction.pool, address: "addr_test1wrong", assets: { lovelace: "1" } } }));
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /signatures/);
  assert.match(result.issues.join(" "), /AMM address/);
  assert.match(result.issues.join(" "), /value does not match/);
});

test("rejects invalid reserves, rounded-to-zero LP shares, and reused Team keys", () => {
  for (const change of [{ fractionAmount: 0n }, { quoteAmount: -1n }, { poolLovelace: 1_999_999n }, { ownerShareBps: 0n }, { ownerShareBps: 10_000n }]) {
    assert.throws(() => reviewBootstrapPlan({ ...plan(), offer: { ...offer, ...change } }), /Invalid bootstrap offer/);
  }
  assert.equal(reviewBootstrapPlan({ ...plan(), offer: { ...offer, fractionAmount: 1n, quoteAmount: 2n, ownerShareBps: 1n } }).ok, false);
  assert.equal(reviewBootstrapPlan({ ...plan(), offer: { ...offer, ownerKey: deployment.admin } }).ok, false);
  assert.equal(reviewBootstrapPlan(plan({ certificates: 1 })).ok, false);
  assert.equal(reviewBootstrapPlan(plan({ withdrawals: 1 })).ok, false);
  assert.equal(reviewBootstrapPlan(plan({ lpPaid: {} })).ok, false);
});
