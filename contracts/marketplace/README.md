# ebecca marketplace contracts

## Current contract status

The currently supported Marketplace is the registry-free shared quote-pool path plus the separate asset-admission registry. Its active validator sources are `asset_registry`, `asset_registry_request`, `one_shot`, `quote_pool`, `lp_policy`, `inventory_policy`, `pool_sell_request`, and `p2p_listing_simple`. See the repository-wide [validator inventory](../../docs/VALIDATOR_INVENTORY.md) before deriving any script.

The legacy oracle/registry and sharded validator families have been moved to `retired-validators/*.ak.disabled`. They are source history only: Aiken does not build them and the application does not load them for new transactions.

## Archived registry sharding (V2)

The former V1 `registry` and `marketplace` validators and V2 sharded path are archived. The following notes describe the retired design only; do not deploy it:

- `registry_root` authenticates the small global root: admin, root NFT, version, pause state, quote assets, and the two shard-policy IDs.
- `policy_shard` stores one `PolicyConfig` per policy ID; `asset_shard` stores an optional, exact-asset `AssetConfig`. Each update consumes only that shard.
- `policy_shard_policy` and `asset_shard_policy` mint one identity-derived NFT only when the admin supplies the authenticated root as a reference input and creates the correctly-bound shard at its validator address. Asset shard names are `blake2b_256(policy_id <> asset_name)`; policy shard names are their policy IDs.
- `marketplace_sharded` uses `ShardedVaultDatum` and requires the root plus matching Policy shard as reference inputs. It accepts an Asset shard only when the caller elects to apply that exact override; all supplied identities, NFT policies, and root bindings are verified on-chain.

Shard updates and shard creation require only a reference input to the root, so unrelated policy updates do not contend. Retiring a shard requires the root admin and burns its state NFT; after retirement the V2 marketplace cannot find that policy/asset shard.


The pool is not a constant-product AMM. It uses authenticated oracle prices and a registry-controlled asset permission model. Sellers can sell approved RWA tokens into a shared settlement reserve, buyers can buy RWA inventory from the pool, liquidity providers can deposit or withdraw the settlement asset through LP shares, and an authorized operator can settle inventory out of the pool only by depositing NAV value.

## Archived oracle/registry contract set

### `validators/one_shot.ak`

Generic one-shot NFT minting policy.

Use it to create unique authentication tokens for:

- pool UTxO
- oracle UTxO
- registry UTxO
- admin or deployment control NFTs

The policy requires a configured seed `OutputReference` to be spent and mints exactly one token with the configured name.

### Archived `registry.ak`

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

### Archived `oracle.ak`

Maintains authenticated bid/ask/NAV pricing.

The oracle datum contains:

- `oracle_token`: unique NFT identifying the authentic oracle UTxO
- `quote`: settlement asset for all quotes in the oracle datum
- `sequence`: monotonically increasing update sequence
- `valid_until`: POSIX-time expiry
- `policy_quotes`: default prices by policy
- `asset_quotes`: asset-level overrides

The pool resolves prices by checking an active asset override first, then the policy default. Oracle updates require the operator signature, preserve the oracle NFT and quote asset, increase `sequence`, set a future `valid_until`, and pass sanity checks: positive denominators, positive bid/ask/NAV, and `bid <= nav <= ask`.

### Archived `marketplace.ak`

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

### Archived `p2p_listing.ak`

Fixed-price orderbook validator for one asset class and any positive quantity.

- `Buy`: consumes the listing only when the configured proceeds address receives the demanded payment and the buyer receives the listed asset.
- `Cancel`: requires the listing management key and returns the escrowed asset and ADA to the proceeds address.
- `Update`: requires the listing management key and recreates the listing at the same script address with updated quantity, price, price asset, or proceeds address.
- Listing UTxOs must contain exactly the listed asset quantity plus locked ADA; unrelated native assets are rejected.
- The validator is parameterized by the registry script address and requires an active exact `AssetConfig` for fills. The registry reference must contain the matching registry identity NFT and datum identity.

### `validators/p2p_listing_simple.ak`

Registry-free fixed-price orderbook variant. It keeps the same exact escrow, buy, cancel, and update behavior, but has no registry datum, registry NFT, registry reference input, or asset allowlist. The requested payment asset is accepted directly from the listing datum.

## Archived pricing model

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

The active smoke checks must target only the active validator set in the validator inventory. The registry/oracle encoders in the archived sections are historical reference material, not a supported deployment path.


### Registry-free shared quote pool

The registry-free path uses p2p_listing_simple for direct listings and the
parameterized quote_pool validator for one shared pool per quote asset (for
example one ADA pool and one USDC pool, not one pool per RWA policy or
fractionalized asset).

This is an oracle/RFQ settlement pool, not a constant-product AMM. A seller
lists an exact asset unit and its minimum quote amount. An allow-listed
batcher may acquire that listing using pool funds, then recreate the asset as
pool-owned inventory with the externally determined ask price. Any buyer can
consume that inventory listing; the quote payment and its ADA buffer return to
the same pool. The exact asset unit and price remain in the orderbook datum,
so the pool can trade many fractionalized assets without a separate
PolicyId/quote pool.

SimpleListingDatum.settlement is either Direct or QuotePool { pool_token,
inventory_token }. The one-unit inventory_token receipt is minted by the
parameterized inventory policy when the batcher acquires a listing and is
burned when that inventory is sold. The pool datum's inventory_value is the sum
of the prices of all open
pool-owned inventory listings, marked at their ask prices. Pool acquisition
increments it and inventory sale decrements it. LP add/remove and pool close
are rejected while it is non-zero, preventing liquidity providers from
ignoring outstanding pool inventory. Pool-owned listings cannot be cancelled
or edited through the generic orderbook path; they must be sold so the pool
accounting changes atomically.

The application presents direct listings and pool inventory in one marketplace
screen. The client-side builder parameterizes quote_pool with the configured
orderbook address before preparing a pool inventory buy. Set
NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS after deploying the registry-free
orderbook; pool addresses/tokens are read from the inventory listing and pool
UTxO datum.

For seller-only instant sell, `pool_sell_request` is parameterized with the
shared pool address. A seller locks an exact RWA asset and a minimum payout in
that request rather than creating a publicly purchasable listing. The pool
batcher later consumes the request together with the pool, pays at least the
minimum, and creates the pool-owned inventory listing. The seller can cancel
the request with its payment key.

## Current application workflows

The `/marketplace` seller control exposes both contract paths:

- **List at my price** creates a public `Direct` listing.
- **Instant sell to pool** creates a `pool_sell_request` with a seller-selected
  minimum payout; it remains pending until the batcher settles or the seller
  cancels.

The `/team` console reads shared-pool cash, protected reserve, inventory value,
and LP supply before presenting the instant-sell pricing queue and reserve
controls. It also reads the exact-asset registry and fails closed for an
unapproved request, but current shared-pool validators do not authenticate that
registry reference. Batcher settlement still requires the configured batcher
signer. An operator may connect that authorized wallet through the console or
use a separate signing service, but the private key must never appear in
browser storage, a client bundle, or a `NEXT_PUBLIC_` variable.

See [Shared-pool Marketplace operations](../../docs/SHARED_POOL_OPERATIONS.md)
for the operational sequence, reconciliation checks, and failure handling.
