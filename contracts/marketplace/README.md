# ebecca-marketplace-contracts-v2

Aiken contracts for an oracle-priced Cardano RWA liquidity pool.

## Production registry sharding (V2)

The V1 `registry` and `marketplace` validators are retained unchanged for a controlled migration. The V2 path is separate and cannot decode or accept a V1 `RegistryDatum`:

- `registry_root` authenticates the small global root: admin, root NFT, version, pause state, quote assets, and the two shard-policy IDs.
- `policy_shard` stores one `PolicyConfig` per policy ID; `asset_shard` stores an optional, exact-asset `AssetConfig`. Each update consumes only that shard.
- `policy_shard_policy` and `asset_shard_policy` mint one identity-derived NFT only when the admin supplies the authenticated root as a reference input and creates the correctly-bound shard at its validator address. Asset shard names are `blake2b_256(policy_id <> asset_name)`; policy shard names are their policy IDs.
- `marketplace_sharded` uses `ShardedVaultDatum` and requires the root plus matching Policy shard as reference inputs. It accepts an Asset shard only when the caller elects to apply that exact override; all supplied identities, NFT policies, and root bindings are verified on-chain.

Shard updates and shard creation require only a reference input to the root, so unrelated policy updates do not contend. Retiring a shard requires the root admin and burns its state NFT; after retirement the V2 marketplace cannot find that policy/asset shard.


The pool is not a constant-product AMM. It uses authenticated oracle prices and a registry-controlled asset permission model. Sellers can sell approved RWA tokens into a shared settlement reserve, buyers can buy RWA inventory from the pool, liquidity providers can deposit or withdraw the settlement asset through LP shares, and an authorized operator can settle inventory out of the pool only by depositing NAV value.

## Contract Set

### `validators/one_shot.ak`

Generic one-shot NFT minting policy.

Use it to create unique authentication tokens for:

- pool UTxO
- oracle UTxO
- registry UTxO
- admin or deployment control NFTs

The policy requires a configured seed `OutputReference` to be spent and mints exactly one token with the configured name.

### `validators/registry.ak`

Maintains the asset registry and risk controls.

The registry datum contains:

- `admin`: key hash allowed to update the registry
- `registry_token`: unique NFT identifying the authentic registry UTxO
- `sequence`: monotonically increasing update sequence
- `policies`: policy-level configs with bucket metadata, trade flags, max exposure, max trade, risk tier, and KYC flag
- `asset_configs`: stricter asset-level controls with frozen/defaulted/redeemed flags and optional caps
- `quote_assets`: settlement assets accepted by pools, such as ADA, USDM, or DJED
- `paused`: global registry pause flag

Registry updates require the admin signature, preserve the registry NFT, recreate a continuing output, and increase `sequence`.

### `validators/oracle.ak`

Maintains authenticated bid/ask/NAV pricing.

The oracle datum contains:

- `oracle_token`: unique NFT identifying the authentic oracle UTxO
- `quote`: settlement asset for all quotes in the oracle datum
- `sequence`: monotonically increasing update sequence
- `valid_until`: POSIX-time expiry
- `policy_quotes`: default prices by policy
- `asset_quotes`: asset-level overrides

The pool resolves prices by checking an active asset override first, then the policy default. Oracle updates require the operator signature, preserve the oracle NFT and quote asset, increase `sequence`, set a future `valid_until`, and pass sanity checks: positive denominators, positive bid/ask/NAV, and `bid <= nav <= ask`.

### `validators/marketplace.ak`

Main pool validator.

The pool datum contains:

- authentication NFTs: `vault_token`, `registry_token`, `oracle_token`
- LP token identity and settlement asset
- `total_lp_supply`
- tracked total, policy, and asset RWA exposure values
- LP fee and protocol fee basis points
- minimum cash reserve and global RWA exposure cap
- treasury address
- pool pause flag

Supported actions:

- `AddLiquidity`: deposits the settlement asset and mints LP shares.
- `RemoveLiquidity`: burns LP shares and withdraws settlement liquidity while preserving minimum cash reserve.
- `SellRwa`: seller deposits an approved RWA and receives bid-price payout less LP/protocol fees.
- `BuyRwa`: buyer pays ask price plus fees and receives RWA inventory.
- `OperatorSettle`: admin/operator removes RWA inventory only by depositing NAV settlement value.
- `AdminUpdate`: admin-only pool parameter and pause update.
- `AdminClose`: admin-only close path.

For trade actions, the pool requires authentic registry and oracle reference inputs, active permissions, unexpired oracle prices, treasury payment when protocol fees are enabled, correct continuing pool value, and updated exposure accounting. Sell actions enforce policy, asset, and global exposure caps plus minimum cash reserve.

### `validators/lp_policy.ak`

LP token minting policy.

The policy allows LP minting or burning only when a pool input containing the configured `vault_token` participates in the transaction. The pool validator then checks the exact LP mint or burn amount for liquidity actions.

## Pricing Model

Quotes use integer ratios:

```text
amount = quantity * numerator / denominator
```

Sell-to-pool uses `bid`:

```text
gross_value = quantity * bid
seller_payout = gross_value - lp_fee - protocol_fee
```

Buy-from-pool uses `ask`:

```text
buyer_payment = quantity * ask + lp_fee + protocol_fee
```

Operator inventory settlement and exposure accounting use `nav`.

## Pokémon Pack Model

The implemented registry supports the recommended model from the requirements:

- policy per product bucket
- asset name per physical item
- policy-level default pricing
- asset-level price overrides for individually appraised, damaged, frozen, or special-provenance items

Bucket metadata can be stored in `PolicyConfig.bucket_id`, for example `SV_JOURNEY_TOGETHER_EN_SLEEVED_PACK`.

## Commands

For the full lifecycle and operational safety procedure, see
[OPERATOR_RUNBOOK.md](OPERATOR_RUNBOOK.md). The included deployment scripts are
Preprod/test tooling; review the runbook's production limitations before using
them with real assets.

Type-check contracts:

```sh
aiken check --skip-tests
```

Run tests:

```sh
aiken check
```

Build the Plutus blueprint:

```sh
aiken build
```

Run offchain syntax checks:

```sh
npm run check:offchain
```

Generate sample datums and redeemers as CBOR:

```sh
npm run offchain:fixtures
```

Print validator addresses, script hashes, and example policy IDs from `plutus.json`:

```sh
npm run offchain:addresses
```

Generate a local preprod test wallet in `.env`:

```sh
npm run offchain:wallet
```

Put your preprod Blockfrost project ID in `.env`:

```sh
BLOCKFROST_PROJECT_ID=preprod...
```

Mint fake Preprod settlement/RWA tokens to the local wallet:

```sh
npm run offchain:mint-test-tokens
```

Run the off-chain smoke test:

```sh
npm run offchain:smoke
```

Run full validator scenario coverage in the Lucid emulator:

```sh
npm run test:full-scenarios
```

The smoke test runs `aiken build`, checks that all expected validators are present in `plutus.json`, and verifies that the JavaScript encoders can serialize registry, oracle, and pool datums.
