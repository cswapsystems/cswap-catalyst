# Contract and Validator Learning Guide

This guide explains the contracts currently in this repository. It is written
as a map for learning and code review, not as a substitute for an audit.

The repository contains three related but separate systems:

1. **Fractionalization** locks an original NFT and creates fungible fraction
   tokens.
2. **Marketplace** supports a registry-free listing escrow and shared reserve pool,
   with a separate asset-approval registry. The oracle/sharded designs are archived.
3. **DEX** is a separate constant-product AMM with one shared script address
   for many individual pools.

The marketplace's shared quote pool is **not** a constant-product AMM. It is
a fixed-price settlement pool: the batcher posts on-chain exact-asset buy/sell
ratios, and validators enforce those prices, the reserve floor and accounting.

The [2026-09-25 deployment record](PREPROD_REDEPLOYMENT_2026-09-25.md) identifies the confirmed hardened Preprod scripts. Current source names are `marketplace_listing_escrow`, `shared_reserve_pool`, `pool_share_policy` and `pool_inventory_receipt_policy`; datum names and API kind `quote-pool` remain unchanged. Renaming source files alone is not a migration of old outputs.

## 1. The Cardano validator model

A Cardano contract does not run continuously and does not call another
contract. It validates a complete transaction.

The important pieces are:

| Piece | Meaning |
| --- | --- |
| UTxO | A box containing ADA, native tokens, and optionally a datum. |
| Datum | State attached to a script output. |
| Redeemer | The caller's claimed action when spending or minting. |
| Validator | A function that accepts or rejects the transaction. |
| Policy | A minting validator that controls token creation or burning. |
| Reference input | Read-only state supplied to a transaction. |
| Continuing output | The replacement UTxO that carries the updated datum/state. |

For example, an orderbook listing is a UTxO at the orderbook script address:

```text
listing UTxO
  value: 10 RWA + ADA buffer
  datum: seller, asset, quantity, price, settlement mode
```

To buy it, the transaction spends that UTxO and must also create outputs that
pay the seller and deliver the RWA to the buyer. The validator checks the
whole transaction rather than trusting a separate marketplace server.

Native assets are identified by `(policy_id, asset_name)`. Asset names are raw
bytes, not display strings. ADA is represented in the shared marketplace
types by an empty policy ID and empty asset name.

## 2. System map

```text
Fractionalization
  original NFT + seed
          |
          v
  vault UTxO + fraction tokens
          |
          +--> fraction marketplace listings
          |
          +--> Combine: burn all fractions -> recover original NFT

Marketplace
  archived registry/oracle path (not deployed by current tooling):
    registry + oracle + marketplace vault + LP policy

  registry-free path:
    simple orderbook <--> shared quote pool
                         |
                         +--> batcher acquires InstantSell listings
                         +--> pool-owned inventory listings

DEX
  bootstrap offer + factory state -> pool NFT + LP token -> shared AMM address
```

The shared types used by the marketplace are in
[`contracts/marketplace/lib/ebecca/types.ak`](../contracts/marketplace/lib/ebecca/types.ak).

## 3. Fractionalization contracts

### 3.1 Fraction minting policy

[`ft_policy.ak`](../contracts/minter/validators/ft_policy.ak) is the one-shot
fungible-token policy used for a fractionalized asset.

Its `Mint` redeemer requires all of the following:

- the configured seed UTxO is consumed;
- the transaction mints exactly one fraction asset under this policy;
- the quantity is the declared `total_fractions`;
- a matching vault output exists;
- the vault contains exactly one original NFT;
- the vault datum names this fraction policy/name, supply, and seed;
- the vault is at the expected vault script hash.

This binds the initial fraction supply to the NFT locked in the vault. The
seed is what makes the parameterized policy unique for that fractionalization
instance.

The `Burn` redeemer permits a negative mint for the fraction asset. The vault
validator supplies the stricter condition for a complete Combine operation:
the burn must equal the entire supply and must not include any other minting.

### 3.2 Vault validator and `VaultDatum`

[`vault.ak`](../contracts/minter/validators/vault.ak) holds the original NFT.
Its datum is:

```text
VaultDatum {
  admin: VerificationKeyHash
  nft_policy: PolicyId
  nft_name: AssetName
  ft_policy: PolicyId
  ft_name: AssetName
  total_fractions: Int
  seed: OutputReference
}
```

It has two actions:

| Redeemer | Purpose | Main checks |
| --- | --- | --- |
| `Update { new_total_fractions }` | Change tracked supply | Admin signature, no minting, same NFT and identity fields, continuing output with inline datum. |
| `Withdraw` | Combine fractions back into the NFT | Burn exactly `total_fractions`, burn nothing else, and send the NFT to a pubkey address. |

The intended Combine transaction is therefore:

```text
spend vault
  + burn exactly total_fractions of the fraction token
  + create a pubkey output containing the original NFT
  + do not create a continuing vault output
```

The fraction policy identifies the correct fraction asset, while the vault
validator proves that the full supply was burned before releasing the NFT.

### 3.3 Other minter policies

- [`multi_nft_policy.ak`](../contracts/minter/validators/multi_nft_policy.ak)
  mints a declared set of one-shot NFTs. Minting consumes a seed and rejects
  duplicate names or extra assets. Burns must be negative for every asset in
  the policy's mint field.
`stt_one_shot` is archived source history, not part of the current build or
deployment set. See [Validator inventory](VALIDATOR_INVENTORY.md).

## 4. Marketplace shared data types

The most important types are:

### `AssetClass`

```text
AssetClass {
  policy_id: PolicyId
  asset_name: AssetName
}
```

This is the marketplace's asset identifier. Never use a ticker as the asset
identity; two assets can have the same display name.

### `Ratio` and `Quote`

Prices are integer ratios:

```text
value = quantity * numerator / denominator
```

`Quote` contains `bid`, `ask`, and `nav`, plus an `active` flag and a maximum
trade value. A sane quote has positive numerators and denominators and obeys:

```text
bid <= nav <= ask
```

Integer division truncates, so off-chain code must calculate slippage and
rounding deliberately.

### Pool datums

The legacy/oracle marketplace calls its pool datum `VaultDatum` in the
marketplace types. The registry-free pool uses `QuotePoolDatum`:

```text
QuotePoolDatum {
  admin: VerificationKeyHash
  batcher: VerificationKeyHash
  pool_token: AssetClass
  lp_token: AssetClass
  inventory_token: AssetClass
  quote_asset: AssetClass
  prices: List<PoolAssetPrice>
  total_lp_supply: Int
  min_cash_reserve: Int
  paused: Bool
  inventory_cost: Int
  inventory_value: Int
  inventory_count: Int
  closing: Option<PoolExit>
}
```

`inventory_token` is a receipt token. One receipt represents one open
pool-owned inventory listing. `inventory_value` is the sum of the ask prices
of those open listings, not cash. `inventory_cost` is their acquisition cost and
contributes to LP share pricing. `closing` records the final exiting LP. This is
the current 14-field datum; a legacy 10-field datum is not interchangeable.

## 5. Retired registry/oracle path

The registry/oracle/sharded marketplace families below are archived source
history. They are retained in the guide only to explain old artifacts; they
are not compiled, exposed through the application, or eligible for new
deployments. The active Marketplace uses the asset registry, `shared_reserve_pool`, and
`marketplace_listing_escrow` listed in the
[validator inventory](VALIDATOR_INVENTORY.md).

This path is implemented by:

- [`registry.ak`](../contracts/marketplace/retired-validators/registry.ak.disabled)
- [`oracle.ak`](../contracts/marketplace/retired-validators/oracle.ak.disabled)
- [`marketplace.ak`](../contracts/marketplace/retired-validators/marketplace.ak.disabled)
- [`pool_share_policy.ak`](../contracts/marketplace/validators/pool_share_policy.ak)
- [`p2p_listing.ak`](../contracts/marketplace/retired-validators/p2p_listing.ak.disabled)

### 5.1 Legacy registry

`RegistryDatum` stores:

- the admin key and registry identity NFT;
- a monotonically increasing sequence number;
- policy-level permissions and exposure limits;
- optional exact-asset overrides;
- allowed settlement assets;
- a global pause flag.

`registry.ak` uses the registry NFT to identify the real state UTxO. An
`Update` requires the admin signature, keeps the same registry NFT and value,
increases `sequence`, and recreates the registry at the same script address
with an inline datum. `Close` requires the admin and consumes the state.

For registry-dependent orderbook fills, the current validator requires both a
valid policy configuration and an exact `AssetConfig`. A policy entry by
itself is not enough to fill a listing through `p2p_listing.ak`.

### 5.2 Oracle

`OracleDatum` stores policy-level and asset-level quotes. The contract resolves
an exact-asset quote first; if none exists, it falls back to the policy quote.

An oracle update requires:

- the operator signature;
- the oracle identity NFT in the input;
- the same quote asset and oracle token;
- a strictly higher sequence;
- a future `valid_until`;
- a transaction validity range ending before expiry;
- sane quotes;
- a continuing output with the same value and the new inline datum.

The marketplace reads this state through a reference input. A trade does not
consume the oracle UTxO, so many trades can use the current quote until it is
updated or expires.

### 5.3 Oracle-priced marketplace pool

[`marketplace.ak`](../contracts/marketplace/retired-validators/marketplace.ak.disabled) uses a
`VaultDatum` containing authentication NFTs for the pool, registry, oracle,
and LP token, plus settlement asset, fees, exposure accounting, cash reserve,
treasury, and pause state.

Its redeemers are:

| Redeemer | Meaning |
| --- | --- |
| `AddLiquidity` | Deposit settlement asset and mint LP shares. |
| `RemoveLiquidity` | Burn LP shares and withdraw settlement liquidity. |
| `SellRwa` | User deposits approved RWA and receives the oracle bid less fees. |
| `BuyRwa` | User pays the oracle ask plus fees and receives RWA inventory. |
| `OperatorSettle` | Authorized operator removes RWA only while depositing NAV value. |
| `AdminUpdate` | Admin changes permitted pool parameters. |
| `AdminClose` | Admin closes the pool. |

For a sell:

```text
gross = quantity * bid
lp_fee = gross * fee_bps / 10_000
protocol_fee = gross * protocol_fee_bps / 10_000
seller_payout = gross - lp_fee - protocol_fee
```

For a buy:

```text
base = quantity * ask
buyer_payment = base + lp_fee + protocol_fee
```

The validator also updates total, policy, and exact-asset exposure. It checks
policy/asset permissions, quote expiry, trade caps, exposure caps, minimum cash
reserve, and the exact continuing pool value.

The LP policy only permits positive or negative LP minting when an input
containing the configured pool token participates. The marketplace validator
then checks the exact LP amount and pool transition.

## 6. Retired sharded registry path

The V2 path separates registry state into small authenticated UTxOs:

- [`registry_root.ak`](../contracts/marketplace/retired-validators/registry_root.ak.disabled)
  stores admin, root NFT, version, pause state, quote assets, and the two shard
  policy IDs.
- [`policy_shard.ak`](../contracts/marketplace/retired-validators/policy_shard.ak.disabled)
  stores one `PolicyConfig`.
- [`asset_shard.ak`](../contracts/marketplace/retired-validators/asset_shard.ak.disabled)
  stores one optional exact `AssetConfig`.
- The two `*_shard_policy.ak` files mint identity NFTs for those shards.
- [`marketplace_sharded.ak`](../contracts/marketplace/retired-validators/marketplace_sharded.ak.disabled)
  is the pool validator using `ShardedVaultDatum`.

The marketplace takes the root as a reference input, then selects the policy
shard for the asset's policy ID. It only applies an asset override when the
caller supplies the matching asset shard. Each shard is independently
consumed and recreated for updates, which reduces contention between unrelated
policy updates.

The V2 datum deliberately uses `root_token` instead of `registry_token`, so a
V1 registry datum cannot accidentally satisfy the V2 marketplace.

## 7. Orderbook validators

### 7.1 Retired registry-dependent orderbook

[`p2p_listing.ak`](../contracts/marketplace/retired-validators/p2p_listing.ak.disabled) is
parameterized by the registry script address. Its `ListingDatum` contains:

```text
ListingDatum {
  seller: Address
  seller_key: VerificationKeyHash
  registry_token: AssetClass
  rwa: AssetClass
  quantity: Int
  price_asset: AssetClass
  price: Int
}
```

The listing UTxO must contain exactly the listed RWA quantity plus its ADA
buffer. Extra native assets are rejected.

| Action | Required result |
| --- | --- |
| `Buy` | Registry allows the asset and quote; seller receives payment plus the ADA buffer; buyer receives the exact RWA quantity. |
| `Cancel` | Seller key signs; seller receives the escrowed RWA and ADA. |
| `Update` | Seller key signs; same asset/seller identity; a continuing listing is created; quantity may be reduced and the released RWA goes to the seller. |

The registry is a reference input during a fill. The listing script does not
trust a registry address alone: it also checks the registry identity NFT and
datum identity.

### 7.2 Registry-free orderbook

[`marketplace_listing_escrow.ak`](../contracts/marketplace/validators/marketplace_listing_escrow.ak)
has the same basic fixed-price orderbook behavior but no registry dependency.
Its `SimpleListingDatum` adds a settlement mode:

```text
SimpleListingDatum {
  seller: Address
  seller_key: VerificationKeyHash
  settlement: Direct | InstantSell { pool_token }
                     | QuotePool { pool_token, inventory_token, acquisition_cost }
  rwa: AssetClass
  quantity: Int
  price_asset: AssetClass
  price: Int
}
```

Settlement constructors are `Direct` (0), `InstantSell` (1) and `QuotePool` (2).
`Direct` pays the seller. `InstantSell` records a seller minimum and can only be
acquired by the configured pool batcher, not publicly bought. `QuotePool` records
pool-owned inventory whose proceeds return to the pool. Cost is distinct from ask.

Direct listings may be bought, cancelled, or updated. Pool-owned listings may
be bought, but cannot be cancelled or updated through the generic listing
path. A pool-owned purchase must be atomic: the same transaction spends a pool
UTxO and creates its continuing pool output. This prevents someone from using
the pool settlement marker without actually updating pool state.

## 8. Registry-free shared quote pool

The shared pool validator is
[`shared_reserve_pool.ak`](../contracts/marketplace/validators/shared_reserve_pool.ak),
parameterized by the orderbook address. A deployment normally has one pool per
quote asset, such as one ADA pool and one USDC pool, rather than one pool per
RWA policy or fractionalized asset.

### 8.1 Receipt token

[`pool_inventory_receipt_policy.ak`](../contracts/marketplace/validators/pool_inventory_receipt_policy.ak)
controls the one-unit receipt token used by pool-owned listings.

- `MintInventory` requires exactly `+1`, a pool input containing the pool NFT,
  and the batcher signature.
- `BurnInventory` allows a negative amount and requires a pool-identity input;
  the consuming pool/listing paths enforce exactly one receipt burned per listing.

The receipt is not the RWA. It is an accounting witness that one inventory
listing is open. The listing also contains the RWA, while the pool datum tracks
the aggregate value of all open inventory.

### 8.2 Pool actions

| Redeemer | What happens |
| --- | --- |
| `AddLiquidity` | Mints LP shares against cash plus inventory cost; allowed with inventory, not paused/closing. |
| `AddFunds` | Adds quote cash without shares; allowed while paused, not closing. |
| `RemoveLiquidity` | Burns partial LP supply for its share of cash above the floor; allowed with inventory or while paused. |
| `StartLpExit` | Burns all remaining LP shares, pays available cash and records the final LP. |
| `ReturnClosingInventory` | Returns one inventory listing and its ADA to the recorded LP, burns its receipt and decrements accounting. The listing spend requires that LP's signature. |
| `CompleteLpExit` | Recorded LP closes after inventory accounting reaches zero; burns identity and receives remaining reserve assets. |
| `BatcherAcquire` | Acquires exactly one InstantSell listing at posted buy/sell prices while preserving the reserve floor. |
| `InventorySale` | Any buyer buys a pool-owned listing; the pool receives the quote payment and the receipt is burned. |
| `Reprice` | Batcher updates one inventory ask and aggregate ask, preserving cost and identity. |
| `UpdatePrices` | Batcher updates posted exact-asset ratios; allowed while paused, not closing. |
| `AdminUpdate` | Admin changes permitted configuration while preserving accounting fields. |
| `AdminClose` | Admin closes an idle pool with zero LP supply and zero inventory cost/ask/count, no recorded LP exit, and a pool-token burn. |

### 8.3 Batcher acquisition flow

```text
1. User creates InstantSell listing:
     RWA + ADA buffer -> orderbook

2. Allow-listed batcher submits one transaction:
     spend pool
     spend exactly one InstantSell listing
     mint inventory receipt (+1)
     pay posted bid from pool and return seller's original listing ADA
     fund new inventory ADA from the batcher wallet
     create pool-owned listing
     create continuing pool datum

3. Pool state changes:
     quote cash decreases by the posted bid only, retaining the reserve floor
     inventory_cost += bid; inventory_value += posted ask; inventory_count += 1
```

The pool-owned listing is bound to the pool by all of these fields:

- `settlement = QuotePool`;
- matching `pool_token` and `inventory_token`;
- listing seller equals the pool address;
- listing seller key equals the batcher key;
- listing price asset equals the pool quote asset.

### 8.4 Seller-only Instant Sell listings

Instant Sell is an orderbook listing with `InstantSell { pool_token }`
settlement in
[`marketplace_listing_escrow.ak`](../contracts/marketplace/validators/marketplace_listing_escrow.ak).
It is not publicly purchasable: its `price` is the seller's minimum total
payout.

```text
1. Seller locks RWA + its ADA buffer in an InstantSell orderbook listing.
2. The seller can cancel at any time with its payment-key signature.
3. The batcher chooses to acquire it at the pool's posted buy price.
4. One transaction spends exactly that listing and the shared pool, pays the
   seller at least the minimum plus the ADA buffer, mints one inventory
   receipt, and creates a pool-owned orderbook listing at the posted ask.
```

`shared_reserve_pool` `BatcherAcquire` requires the batcher signature, exactly one
Instant Sell listing for the pool, a posted price for the exact asset, and cash
above `min_cash_reserve` after the payout. The earlier separate request
validator (`pool_sell_request`) is archived; see the
[validator inventory](VALIDATOR_INVENTORY.md).

### 8.5 Inventory sale flow

```text
1. Buyer chooses a pool-owned listing.
2. Transaction spends the pool-owned listing and the pool UTxO.
3. Buyer receives the listed RWA.
4. Pool receives the listing price and the ADA buffer.
5. Inventory receipt is burned (-1).
6. inventory_cost falls by acquisition cost, inventory_value by ask, count by one.
```

The continuing pool must still contain at least `min_cash_reserve`. Because the
pool UTxO and listing are both consumed, the value movement and accounting
update happen atomically.

### 8.6 LP accounting with open inventory

Deposits use cash plus acquisition cost, not asking value. Partial withdrawals
pay `lp_burned * (cash - min_cash_reserve) / total_lp_supply` using integer
division. They give up inventory exposure and can return zero; the UI requires
explicit acknowledgment of a zero payout. Open inventory does not block deposits
or partial withdrawals. Deposits remain blocked while paused or closing.

Final exit is a sequence: burn all shares and record the LP, return each remaining
listing and burn its receipt, then close and burn the pool identity. Completion
returns the remaining reserve, including the protected floor. The current
manifest records the public identity seed and matches the burn-capable policy;
old mint-only identities cannot use that policy retroactively.

### 8.7 Operator console and client boundary

`/team` uses fresh pool state, posted prices and off-chain quantity/activity
limits. It does not require registry membership for acquisition. `/team/inventory`
separates signed on-chain pricing from signed, revision-checked off-chain limits;
`/portfolio/reserves` hosts LP actions. Operator-only route access is a UI guard,
not signing authority. Validators and APIs enforce the actual signer. Preserve
approval receipts and confirmed hashes; page state is not a durable audit log.

## 9. Constant-product DEX

The DEX is separate from the marketplace and is implemented by:

- [`factory_state.ak`](../contracts/dex/validators/factory_state.ak)
- [`factory_bootstrap.ak`](../contracts/dex/validators/factory_bootstrap.ak)
- [`bootstrap_offer.ak`](../contracts/dex/validators/bootstrap_offer.ak)
- [`pool_factory.ak`](../contracts/dex/validators/pool_factory.ak)
- [`amm_pool.ak`](../contracts/dex/validators/amm_pool.ak)
- [`lp_policy.ak`](../contracts/dex/validators/lp_policy.ak)

### 9.1 Factory state

`FactoryDatum` contains the factory NFT, admin, pool-NFT policy, next pool ID,
and pause flag. The factory state is consumed when creating a pool and is a
reference input for swaps and normal LP operations. This avoids making every
swap contend on the factory UTxO.

`factory_bootstrap.ak` creates the factory NFT once from a seed UTxO.
`factory_state.ak` lets the admin advance the pool ID or pause/unpause creation
and trading. Its second parameter is the shared bootstrap-offer address.

`Advance` and `SetPaused` require the factory-admin signature.
`AdvanceBootstrap` also requires that Team-admin signature plus an input at
the configured bootstrap-offer script address. The offer validator must then
independently pass and requires the distinct LP signer, so this is a
three-party constrained pool creation path, not a general permissionless
factory update.

### 9.2 Pool creation and identity

`pool_factory.ak` mints one deterministic pool NFT for each new pool. The NFT
asset name is the big-endian 8-byte `next_pool_id`. The matching LP token uses
the same asset name under the LP policy.

Every live pool is a different UTxO at one shared `amm_pool` script address.
The pool NFT identifies which datum/value belongs to that pool.

### 9.3 Three-party FT bootstrap

`BootstrapOfferDatum` locks the owner address/key, factory token, FT asset and
quantity, quote asset/reserve, fixed ADA buffer, and owner LP share in basis
points. The offer UTxO contains exactly the FT contribution plus its ADA
buffer.

The FT provider signs the offer-creation transaction. A distinct LP prepares
and signs acceptance, and the configured factory Team creator/admin must sign
the same complete transaction. Acceptance consumes the offer and factory
state, creates the next deterministic pool, mints exactly the initial LP
supply, and pays both declared participants. For tADA/FT, the LP supplies the
amount needed to reach the final ADA reserve after the owner buffer. For
USDCx/FT, the LP supplies the full USDCx reserve while the owner buffer stays
as `pool_lovelace`. The FT provider can cancel an unaccepted offer with its
payment-key signature. All three payment-key hashes must be different.

### 9.4 AMM rules

`PoolDatum` stores two assets, reserves, fee ratio, LP supply, pool NFT, LP
token, and locked lovelace. The AMM validator enforces:

- swaps satisfy the fee-adjusted constant-product bound;
- the caller's minimum output is met;
- liquidity additions preserve the reserve ratio;
- LP minting matches the change in total liquidity;
- liquidity removals burn matching LP tokens and respect minimum outputs;
- the full expected pool value, including NFT and lovelace, is preserved;
- close requires the factory admin and burns the pool NFT and full LP supply.

This is fundamentally different from the marketplace quote pool. The DEX
derives prices from reserves and the invariant; the marketplace quote pool
uses external batcher prices and tracks open inventory obligations. The DEX
workbench preserves `pool_lovelace` as a fixed buffer for token/token pools;
for ADA pairs it follows the ADA reserve.

## 10. How to read a transaction

When debugging any contract interaction, inspect these items in order:

1. **Inputs:** Which script UTxOs are consumed? Which NFTs identify their
   datum/state? Are reference inputs present?
2. **Datums:** What is the current state, and what state is promised in the
   continuing output?
3. **Redeemers:** Which branch is selected? Are its amounts and addresses
   consistent with the intended action?
4. **Mint field:** Are tokens minted or burned exactly as the policy and state
   validator expect?
5. **Outputs:** Is the required value paid to the seller, buyer, LP, treasury,
   or pool? Are there extra native assets in a supposedly exact escrow?
6. **Signers:** Is the seller, batcher, admin, oracle operator, or LP provider
   signer present where required?
7. **Validity interval:** Is an oracle quote still valid for the transaction?

For marketplace state, the most useful invariants to compare before and after
are:

```text
pool token remains in exactly one continuing pool output
LP supply change == LP mint/burn
inventory_value change == open listing price change
RWA exposure change == asset movement
quote cash movement == payment movement
```

## 11. Tests and verification

The Aiken tests are executable examples of the validator rules. Run the
contract suites with the repository's Aiken binary or an installed compatible
version:

```sh
cd contracts/marketplace
aiken check --deny .

cd ../minter
aiken check .

cd ../dex
aiken check --deny .
```

Use the compiler pinned by each project's `aiken.toml`; the minter's older pin
can cause strict warning-as-error checks to fail with a different compiler.
From the repository root, application and off-chain checks are:

```sh
npm run lint
node --experimental-strip-types --test tests/*.test.mjs
npm run test:offchain
npm run build:preprod
npm run test:browser
```

Marketplace emulator tests exercise exact escrow, receipt authorization/burning,
posted prices, inventory accounting, LP actions with inventory and final identity
burning. DEX tests cover AMM arithmetic, exact token-pool ADA, three-party
signatures, LP allocation, malformed-offer cancellation and hostile approval
transactions. See [DEX validation](DEX_VALIDATION.md) and [UI testing](UI_TESTING.md)
for dated results and remaining real-wallet acceptance. Automated checks do not
replace real Eternl account switching during approval or a browser three-wallet
walkthrough. Rebuilding a blueprint is a deliberate artifact change, not a
routine documentation/test step; review deployment compatibility afterward.

## 12. Important operational boundaries

- The contracts are not audited production code.
- Admin, oracle operator, batcher, and minting-policy keys are separate trust
  boundaries and should not be casually combined.
- The simple orderbook intentionally has no registry allowlist. Any policy or
  asset can be listed unless the application or deployment process imposes an
  allow-list.
- KYC/redemption flags belong to archived registry/oracle designs. The current
  asset registry records exact-asset issuer approval, not a complete compliance workflow.
- Current registry approval and posted pool prices identify exact assets.
  Historical policy-wide admission is not interchangeable with either.
- Min-UTxO ADA buffers are part of the exact value checks. A transaction can be
  logically correct and still fail if it does not provide enough ADA for the
  output datum and native assets.
- The batcher can post prices without on-chain bands or spread limits. Validators
  enforce posted prices, the configured signer, accounting and the reserve floor,
  not valuation quality or off-chain quantity/activity controls.

For historical operational details of the retired registry/oracle pool, see
[`contracts/marketplace/OPERATOR_RUNBOOK.md`](../contracts/marketplace/OPERATOR_RUNBOOK.md).
For current operational sequencing, see [Shared-pool operations](SHARED_POOL_OPERATIONS.md).
For the marketplace's current behavior and archived design notes, see
[`contracts/marketplace/README.md`](../contracts/marketplace/README.md).
