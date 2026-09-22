# Testing the RWA Liquidity Pool

This guide describes how to test the contracts beyond a basic compile. The current repository includes Aiken unit checks for shared helpers and JavaScript smoke tests for blueprint generation and datum/redeemer encoding. Full confidence requires emulator or testnet transaction tests that exercise each validator branch with real UTxO values, reference inputs, mint fields, signers, and validity ranges.

## 1. Local Prerequisites

Install dependencies:

```sh
npm install
```

Confirm Aiken is available:

```sh
aiken --version
```

The project is pinned to Aiken `v1.1.21` in `aiken.toml`.

## 2. Fast Local Checks

Run contract type-checks and unit tests:

```sh
aiken check
```

Run a compile-only check:

```sh
aiken check --skip-tests
```

Build the Plutus blueprint:

```sh
aiken build
```

Run JavaScript syntax checks:

```sh
npm run check:offchain
```

Generate sample datums and redeemers:

```sh
npm run offchain:fixtures
```

Run the offchain smoke test:

```sh
npm run offchain:smoke
```

A passing smoke test proves that the active blueprint can be generated and its supported encoders serialize successfully. It does not prove that every transaction branch validates. The historical oracle/registry validators are archived; see the [validator inventory](../../docs/VALIDATOR_INVENTORY.md).

## Archived 2.1 V2 sharding coverage

The sharded contracts below are archived source history. Do not use this checklist for a new deployment:

- root, Policy-shard, and Asset-shard references must each carry their configured identity NFT and matching inline datum;
- every trade requires the root and exactly matching Policy shard; a V1 registry datum fails to decode in `marketplace_sharded`;
- Asset overrides are accepted only for the exact `(policy ID, asset name)` and cannot stand in for a Policy shard;
- Policy and Asset shard updates retain their identity fields and use the root admin; separate shards can update concurrently;
- a retirement transaction must burn the corresponding shard NFT, making future V2 trades for that policy fail unless a newly-authorized shard is created.

The repository includes a full Lucid emulator scenario harness:

```sh
npm run test:full-scenarios
```

This harness exercises positive validator paths and expected-failure cases without submitting failing transactions to a public testnet.

## 3. Active validator tests to add

Use a Cardano emulator, Lucid transaction tests, or testnet scripts to build full transactions for every active redeemer path. The detailed oracle/registry cases below are historical reference; prioritize the active registry, quote-pool, Instant Sell, and direct-listing paths in the validator inventory. Each test should spend the pool UTxO, attach the required reference inputs, recreate the continuing pool output with the expected inline datum, and verify the transaction either validates or fails for the expected reason.

Required positive tests:

- Sell RWA to pool succeeds using an active asset-level price override.
- Sell RWA to pool succeeds using the policy-level default when no asset override exists.
- Buy RWA from pool succeeds using the oracle ask price.
- Add liquidity succeeds and mints the exact LP share amount.
- Remove liquidity succeeds and burns the exact LP share amount.
- Oracle update succeeds with the authorized oracle operator and increased sequence.
- Registry update succeeds with the authorized admin and increased sequence.
- Pool admin update succeeds for pause/fee/risk parameter changes while preserving economic state.
- Operator settlement succeeds only when the pool receives NAV settlement value.

Required negative tests:

- Sell fails when the oracle reference input is missing.
- Sell or buy fails when the oracle has expired.
- Sell or buy fails when the registry reference input is missing.
- Sell fails when the policy is missing, inactive, or sell-disabled.
- Buy fails when the policy is missing, inactive, or buy-disabled.
- Sell or buy fails when an asset override is frozen, defaulted, redeemed, inactive, or disabled.
- Sell fails when seller payout is below the required bid-price net payout.
- Sell fails when the pool does not receive the RWA token.
- Buy fails when buyer payment is below ask price plus fees.
- Buy fails when the pool does not send the RWA token.
- Sell fails when policy, asset, or global exposure caps would be exceeded.
- Sell and withdraw fail when the pool would fall below `min_cash_reserve`.
- Protocol-fee trades fail when the treasury output is missing or underpaid.
- LP minting fails outside a valid `AddLiquidity` pool transaction.
- LP burning fails outside a valid `RemoveLiquidity` pool transaction.
- Oracle update fails for unauthorized signer, non-increased sequence, expired `valid_until`, inactive quotes, bad denominators, or `bid > nav > ask` violations.
- Registry update fails for unauthorized signer, non-increased sequence, or invalid negative caps.
- Operator settlement fails without admin signature.
- Operator settlement fails when the pool does not receive the required NAV settlement value.

## 4. Emulator Transaction Shape

Every pool transaction should include:

- Pool script input with the current `VaultDatum` and exactly one `vault_token`.
- Continuing pool output at the pool script address with exactly one `vault_token` and the expected next `VaultDatum`.
- Registry reference input containing exactly one trusted `registry_token` and a `RegistryDatum`.
- Oracle reference input containing exactly one trusted `oracle_token` and an `OracleDatum`.
- Transaction validity range ending before `oracle.valid_until` for price-using actions.
- Correct settlement and RWA value delta in the continuing pool output.
- Correct LP mint or burn in `tx.mint` for liquidity actions.
- Required recipient outputs for seller, buyer, LP, operator, and treasury.

For negative tests, mutate one field at a time so the failure reason is isolated.

## 5. Test Data Recommendations

Use one policy as a Pokemon product bucket, for example:

```text
SV_JOURNEY_TOGETHER_EN_SLEEVED_PACK
```

Use unique asset names for physical items:

```text
PACK_000001
PACK_000002
BOX_000001
```

Use at least two quote assets in registry tests:

- ADA
- a native asset such as USDM

Use quote ratios where arithmetic is easy to inspect:

```text
bid = 140 / 100
nav = 150 / 100
ask = 170 / 100
```

Then test fee calculations with non-zero values, for example:

```text
fee_bps = 50
protocol_fee_bps = 25
```

## 6. Suggested Test Harness

A practical harness should add a new script such as:

```text
offchain/pool-emulator-tests.mjs
```

The script should:

1. Build or load `plutus.json`.
2. Create deterministic auth assets for pool, oracle, registry, and LP token identities.
3. Construct registry, oracle, and pool UTxOs with inline datums.
4. Build each transaction scenario with Lucid or a Cardano emulator provider.
5. Assert validation success or expected failure.
6. Print a compact scenario summary.

Add a package script once the harness exists:

```json
{
  "scripts": {
    "test:pool": "node offchain/pool-emulator-tests.mjs"
  }
}
```

## 7. Testnet Smoke Flow

After emulator coverage passes, run a preprod or preview smoke test:

Create a local preprod env file and wallet:

```sh
cp .env.example .env
npm run offchain:wallet
```

Put the Blockfrost project ID for your preprod project in:

```sh
BLOCKFROST_PROJECT_ID=preprod...
```

Mint fake Preprod settlement/RWA tokens:

```sh
npm run offchain:mint-test-tokens
```

1. Mint one-shot NFTs for pool, oracle, registry, and admin.
2. Mint or prepare one settlement asset and one sample RWA token.
3. Create the registry UTxO with an active policy config and optional asset config.
4. Create the oracle UTxO with active bid/ask/NAV quotes and future `valid_until`.
5. Create the pool UTxO with initial settlement liquidity and pool NFT.
6. Run `AddLiquidity` and confirm LP tokens are minted.
7. Run `SellRwa` and confirm seller payout, treasury fee, pool RWA inventory, and exposure datum updates.
8. Run `BuyRwa` and confirm buyer receives RWA, treasury fee is paid, and exposure decreases.
9. Run `OperatorSettle` and confirm RWA leaves only when NAV settlement enters.
10. Pause the pool with `AdminUpdate` and confirm buy/sell transactions fail while paused.

Record transaction hashes and final UTxO datums for audit.
