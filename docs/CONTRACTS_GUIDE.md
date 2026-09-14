# Contract and Validator Learning Guide

This guide explains the contracts currently in this repository. It is written
as a map for learning and code review, not as a substitute for an audit.

The repository contains three related but separate systems:

1. **Fractionalization** locks an original NFT and creates fungible fraction
   tokens.
2. **Marketplace** supports a registry/oracle-controlled RWA pool and a
   simpler registry-free orderbook plus shared quote pool.
3. **DEX** is a separate constant-product AMM with one shared script address
   for many individual pools.

The marketplace's shared quote pool is **not** a constant-product AMM. It is
an oracle/RFQ-style settlement pool: an off-chain batcher decides inventory
prices and the on-chain contracts verify the settlement and accounting.

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
  registry/oracle path:
    registry + oracle + marketplace vault + LP policy

  registry-free path:
    simple orderbook <--> shared quote pool
                         |
                         +--> batcher buys direct listings
                         +--> pool-owned inventory listings

DEX
  factory state -> pool NFT + LP token -> shared AMM address
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
- [`stt_one_shot.ak`](../contracts/minter/validators/stt_one_shot.ak) mints a
  single one-shot token by consuming a seed and burns it only when an input
  contains that token.

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
  total_lp_supply: Int
  min_cash_reserve: Int
  paused: Bool
  inventory_value: Int
}
```

`inventory_token` is a receipt token. One receipt represents one open
pool-owned inventory listing. `inventory_value` is the sum of the ask prices
of those open listings.

## 5. Registry and oracle path

This path is implemented by:

- [`registry.ak`](../contracts/marketplace/validators/registry.ak)
- [`oracle.ak`](../contracts/marketplace/validators/oracle.ak)
- [`marketplace.ak`](../contracts/marketplace/validators/marketplace.ak)
- [`lp_policy.ak`](../contracts/marketplace/validators/lp_policy.ak)
- [`p2p_listing.ak`](../contracts/marketplace/validators/p2p_listing.ak)

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

[`marketplace.ak`](../contracts/marketplace/validators/marketplace.ak) uses a
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

## 6. Sharded registry path

The V2 path separates registry state into small authenticated UTxOs:

- [`registry_root.ak`](../contracts/marketplace/validators/registry_root.ak)
  stores admin, root NFT, version, pause state, quote assets, and the two shard
  policy IDs.
- [`policy_shard.ak`](../contracts/marketplace/validators/policy_shard.ak)
  stores one `PolicyConfig`.
- [`asset_shard.ak`](../contracts/marketplace/validators/asset_shard.ak)
  stores one optional exact `AssetConfig`.
- The two `*_shard_policy.ak` files mint identity NFTs for those shards.
- [`marketplace_sharded.ak`](../contracts/marketplace/validators/marketplace_sharded.ak)
  is the pool validator using `ShardedVaultDatum`.

The marketplace takes the root as a reference input, then selects the policy
shard for the asset's policy ID. It only applies an asset override when the
caller supplies the matching asset shard. Each shard is independently
consumed and recreated for updates, which reduces contention between unrelated
policy updates.

The V2 datum deliberately uses `root_token` instead of `registry_token`, so a
V1 registry datum cannot accidentally satisfy the V2 marketplace.

## 7. Orderbook validators

### 7.1 Registry-dependent orderbook

[`p2p_listing.ak`](../contracts/marketplace/validators/p2p_listing.ak) is
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

[`p2p_listing_simple.ak`](../contracts/marketplace/validators/p2p_listing_simple.ak)
has the same basic fixed-price orderbook behavior but no registry dependency.
Its `SimpleListingDatum` adds a settlement mode:

```text
SimpleListingDatum {
  seller: Address
  seller_key: VerificationKeyHash
  settlement: Direct | QuotePool { pool_token, inventory_token }
  rwa: AssetClass
  quantity: Int
  price_asset: AssetClass
  price: Int
}
```

`Direct` means payment goes to the seller. `QuotePool` means the listing is
owned by a shared pool and the listing's proceeds return to that pool.

Direct listings may be bought, cancelled, or updated. Pool-owned listings may
be bought, but cannot be cancelled or updated through the generic listing
path. A pool-owned purchase must be atomic: the same transaction spends a pool
UTxO and creates its continuing pool output. This prevents someone from using
the pool settlement marker without actually updating pool state.

## 8. Registry-free shared quote pool

The shared pool validator is
[`quote_pool.ak`](../contracts/marketplace/validators/quote_pool.ak),
parameterized by the orderbook address. A deployment normally has one pool per
quote asset, such as one ADA pool and one USDC pool, rather than one pool per
RWA policy or fractionalized asset.

### 8.1 Receipt token

[`inventory_policy.ak`](../contracts/marketplace/validators/inventory_policy.ak)
controls the one-unit receipt token used by pool-owned listings.

- `MintInventory` requires exactly `+1`, a pool input containing the pool NFT,
  and the batcher signature.
- `BurnInventory` requires exactly `-1`.

The receipt is not the RWA. It is an accounting witness that one inventory
listing is open. The listing also contains the RWA, while the pool datum tracks
the aggregate value of all open inventory.

### 8.2 Pool actions

| Redeemer | What happens |
| --- | --- |
| `AddLiquidity` | Adds quote asset, mints the calculated LP amount, and requires no open inventory. |
| `RemoveLiquidity` | Burns LP tokens, withdraws only above `min_cash_reserve`, and requires no open inventory. |
| `BatcherAcquire` | Batcher buys a `Direct` listing using pool funds and creates a pool-owned listing. |
| `BatcherInstantSell` | Batcher settles a seller-only pool request at or above its minimum payout and creates a pool-owned listing. |
| `InventorySale` | Any buyer buys a pool-owned listing; the pool receives the quote payment and the receipt is burned. |
| `AdminUpdate` | Admin changes permitted configuration while preserving accounting fields. |
| `AdminClose` | Admin closes only when `inventory_value == 0` and burns the pool token. |

### 8.3 Batcher acquisition flow

```text
1. User creates Direct listing:
     RWA + ADA buffer -> orderbook

2. Allow-listed batcher submits one transaction:
     spend pool
     spend Direct listing
     mint inventory receipt (+1)
     pay seller from pool
     create pool-owned listing
     create continuing pool datum

3. Pool state changes:
     quote cash decreases by purchase price + listing ADA buffer
     inventory_value increases by the new ask price
```

The pool-owned listing is bound to the pool by all of these fields:

- `settlement = QuotePool`;
- matching `pool_token` and `inventory_token`;
- listing seller equals the pool address;
- listing seller key equals the batcher key;
- listing price asset equals the pool quote asset.

### 8.4 Seller-only instant-sale requests

[`pool_sell_request.ak`](../contracts/marketplace/validators/pool_sell_request.ak)
is parameterized by the shared-pool address. It keeps an instant-sale request
separate from a public P2P listing. Its datum binds the seller and cancellation
key, the pool identity token, exact RWA unit and quantity, quote asset, and
minimum payout.

```text
1. Seller locks RWA + its ADA buffer in a pool-sell-request UTxO.
2. The seller can cancel at any time with its payment-key signature.
3. The allow-listed batcher chooses to accept a request.
4. One transaction spends the request and shared pool, pays the seller at
   least the stated minimum, mints the inventory receipt, and creates a
   pool-owned orderbook listing.
```

The request validator requires the authenticated pool to be spent in the
settlement transaction and requires the seller's payout. The quote-pool
validator separately requires its batcher signature, checks that the exact
request asset becomes inventory, and debits the reserve by the settled amount
plus the request's ADA buffer. This keeps the batcher key off the browser while
making a seller's minimum payout and cancellation right enforceable on-chain.

### 8.5 Inventory sale flow

```text
1. Buyer chooses a pool-owned listing.
2. Transaction spends the pool-owned listing and the pool UTxO.
3. Buyer receives the listed RWA.
4. Pool receives the listing price and the ADA buffer.
5. Inventory receipt is burned (-1).
6. inventory_value decreases by the listing price.
```

The continuing pool must still contain at least `min_cash_reserve`. Because the
pool UTxO and listing are both consumed, the value movement and accounting
update happen atomically.

### 8.5 Why liquidity changes stop while inventory is open

An open inventory listing is an obligation: the pool has already spent cash to
acquire an asset and has promised to sell it at the orderbook ask. If LPs were
allowed to add/remove liquidity or close the pool while that listing remained
open, the pool's liabilities and LP claims could become difficult to reconcile.

The contract therefore requires:

```text
AddLiquidity:    current.inventory_value == 0 && next.inventory_value == 0
RemoveLiquidity: current.inventory_value == 0 && next.inventory_value == 0
AdminClose:      current.inventory_value == 0
```

This is a deliberately conservative settlement rule. It makes pool-owned
inventory operationally simple: sell all open inventory before changing LP
state or closing the pool.

## 9. Constant-product DEX

The DEX is separate from the marketplace and is implemented by:

- [`factory_state.ak`](../contracts/dex/validators/factory_state.ak)
- [`factory_bootstrap.ak`](../contracts/dex/validators/factory_bootstrap.ak)
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
and trading.

### 9.2 Pool creation and identity

`pool_factory.ak` mints one deterministic pool NFT for each new pool. The NFT
asset name is the big-endian 8-byte `next_pool_id`. The matching LP token uses
the same asset name under the LP policy.

Every live pool is a different UTxO at one shared `amm_pool` script address.
The pool NFT identifies which datum/value belongs to that pool.

### 9.3 AMM rules

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
uses external batcher prices and tracks open inventory obligations.

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
aiken check .
aiken build .

cd ../minter
aiken check .
aiken build .

cd ../dex
aiken check .
aiken build .
```

The frontend checks are:

```sh
npm run lint
npm run build
```

The current repository also contains marketplace tests for exact pool-owned
escrow, receipt authorization/burning, and blocking liquidity changes while
inventory is open. These are validator-level simulations; they do not replace
a network submission test with real UTxOs, min-UTxO values, wallet signing,
datum encoding, and the target network's actual ledger behavior.

## 12. Important operational boundaries

- The contracts are not audited production code.
- Admin, oracle operator, batcher, and minting-policy keys are separate trust
  boundaries and should not be casually combined.
- The simple orderbook intentionally has no registry allowlist. Any policy or
  asset can be listed unless the application or deployment process imposes an
  allow-list.
- Registry/oracle flags such as KYC and redemption are represented in datum
  state, but the current marketplace validator does not enforce a complete KYC
  workflow.
- Policy-wide registry admission and exact-asset configuration are different
  concepts. Review which validator path is deployed before assuming a policy
  ID alone is sufficient.
- Min-UTxO ADA buffers are part of the exact value checks. A transaction can be
  logically correct and still fail if it does not provide enough ADA for the
  output datum and native assets.
- The batcher's external allow-list and oracle decision process are currently
  off-chain controls. The on-chain contracts enforce the configured batcher
  key, pool accounting, and transaction shape, but not the batcher's private
  business policy.

For the operational details of the registry/oracle pool, see
[`contracts/marketplace/OPERATOR_RUNBOOK.md`](../contracts/marketplace/OPERATOR_RUNBOOK.md).
For the marketplace's existing design notes, see
[`contracts/marketplace/README.md`](../contracts/marketplace/README.md).
