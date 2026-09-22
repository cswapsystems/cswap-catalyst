# Ebecca DEX contract architecture

## Purpose

Ebecca DEX is a multi-pool constant-product AMM for Cardano. All live pools share one `amm_pool` script address. A pool is an individual UTxO identified by a singleton pool NFT and an inline `PoolDatum`; a new validator is not deployed for each trading pair.

This design keeps the AMM address stable while the factory provides authenticated pool identity, deterministic token names, and an administrator-controlled pause/decommission boundary.

## Components

| Component | Parameter(s) | Responsibility |
| --- | --- | --- |
| `factory_bootstrap` | seed output reference, factory-state address, factory token name | One-time policy that mints the factory-state NFT only while consuming the selected seed UTxO. |
| `factory_state` | Team admin verification-key hash, bootstrap-offer address | Holds `FactoryDatum`; authorizes normal advances and Team-approved three-party bootstrap advances. |
| `bootstrap_offer` | none | Escrows an FT provider’s exact contribution and fixed pool terms until a distinct LP and Team creator approve, or the provider cancels. |
| `amm_pool` | factory-state NFT | Shared spending validator for every pool. |
| `lp_policy` | factory-state NFT, shared AMM address | Mints/burns each pool’s LP supply only for valid AMM transitions. |
| `pool_factory` | factory-state NFT, shared AMM address, LP policy ID | Mints/burns pool NFTs for valid create/close flows. |

All scripts are Plutus V3 and are emitted in `plutus.json` by `aiken build`.

## Script derivation and deployment order

1. Select a funded, wallet-owned seed UTxO.
2. Derive the unparameterized `bootstrap_offer` address.
3. Derive `factory_state(admin, bootstrap_offer_address)` and its script address.
4. Derive `factory_bootstrap(seed, factory_state_address, token_name)`. Its policy ID plus the token name is the factory-state NFT.
5. Derive `amm_pool(factory_state_nft)` once. Its address is the single address for every pool in this deployment.
6. Derive `lp_policy(factory_state_nft, amm_address)` and obtain its policy ID.
7. Derive `pool_factory(factory_state_nft, amm_address, lp_policy_id)` and obtain its policy ID.
8. Mint the factory NFT with `factory_bootstrap` and place it in a `factory_state` UTxO with an inline `FactoryDatum`.

The bootstrap seed is consumed exactly once. Changing the seed, admin, factory-token name, or blueprint changes the derived deployment identifiers.

## Datum and asset model

`AssetId` uses raw Cardano bytes. ADA is represented as an empty policy ID and empty asset name.

```text
FactoryDatum {
  factory_token,
  admin,
  pool_nft_policy,
  next_pool_id,
  paused,
}

PoolDatum {
  pool_nft,
  asset_a, asset_b,
  lp_token,
  fee_numerator, fee_denominator,
  reserve_a, reserve_b,
  total_liquidity,
  pool_lovelace,
}

BootstrapOfferDatum {
  owner, owner_key, factory_token,
  fraction_asset, fraction_amount,
  quote_asset, quote_amount,
  pool_lovelace, owner_share_bps,
}
```

The NFT and LP asset names are the 8-byte big-endian representation of `next_pool_id`. A creation transaction advances this counter exactly once and mints exactly one matching pool NFT.

`pool_lovelace` represents the entire lovelace held in the pool UTxO:

- for an ADA pair it equals the ADA reserve and changes as trades/liquidity changes change the ADA reserve;
- for a token/token pair it is the exact min-UTxO lovelace value for the complete output, including its inline datum and all assets.

The contract reconstructs and compares the full expected UTxO value, preventing unrelated assets from being trapped in or extracted from a pool.

## Transaction flows and enforced invariants

### Factory bootstrap

The bootstrap policy requires the chosen seed input, exactly one factory NFT, and one factory-state output at the configured address. The datum must identify that NFT and define a non-empty pool factory policy.

### Create pool

The transaction consumes the factory-state UTxO with `Advance`, carries its factory NFT to exactly one successor, increments `next_pool_id`, mints one pool NFT, mints initial LP supply, and creates one valid pool output at the shared AMM address. The state validator, pool-factory policy, and LP policy independently verify the same transition.

### Three-party FT bootstrap

An FT provider can lock the fraction asset and exact pool terms in `BootstrapOfferDatum`: the tADA or USDCx quote asset and final reserve, ADA buffer, and basis-point LP split. A different liquidity-provider address prepares `AcceptBootstrap`, funds the quote side, and signs the complete transaction. The configured Team creator/admin must review and sign that same transaction. It then consumes both the offer and factory state with `AdvanceBootstrap`, creates the deterministic pool UTxO, mints its pool NFT and full LP supply, and pays each party its declared LP allocation.

For tADA/FT, the owner buffer is part of the final ADA reserve and the provider funds the remaining ADA. For USDCx/FT, the owner locks the exact ADA buffer while the provider funds the full USDCx reserve. Initial supply is `floor(sqrt(quote_reserve * FT_reserve))`; the owner receives `floor(total_lp * owner_share_bps / 10_000)` and the provider receives the remainder.

The FT provider may cancel an unaccepted offer only with the stored payment-key signature. `AdvanceBootstrap` requires the factory-admin/Team signature and an offer input at the configured validator address; the offer validator independently enforces the pair, reserves, pool ID, buffer, allocation, distinct role keys, LP signer, and Team signer.

### Swap

`Swap { minimum_amount_out }` preserves LP supply. The validator enforces a fee-adjusted constant-product output bound and rejects exhausted pools. The factory state is a reference input, so swaps do not consume the factory UTxO.

### Add liquidity

The added reserves must have the exact existing reserve ratio. The LP policy must mint the same amount by which `total_liquidity` rises, and the AMM enforces the caller’s minimum LP output.

### Remove liquidity

The transaction burns the same LP amount by which `total_liquidity` falls. Withdrawals are rounded down proportionally and must satisfy the caller’s minimum outputs. Partial withdrawal only is supported through this path.

### Close pool

`Close { recipient }` requires the factory-admin signature. It burns the one pool NFT and the full LP supply, produces no successor NFT-bearing pool output, and pays both reserves plus all locked lovelace to the nominated recipient. It remains available while paused to support orderly decommissioning.

### Pause behavior

The factory admin can use `SetPaused`. A paused factory rejects new pools, swaps, and LP mint/burn updates. Closing an existing pool remains possible.

## Off-chain requirements

A transaction builder must:

- encode asset names as bytes, not display text;
- use inline datum encodings matching the blueprint;
- include the factory state as a reference input for AMM/LP operations;
- consume it, attach `factory_state`, and include the admin signer for a normal `Advance` pool creation;
- for a three-party bootstrap, consume the matching offer and factory state with `AdvanceBootstrap`, attach both spending validators and both minting policies, ensure the distinct LP funds the fixed quote side, include the LP and Team signatures, and pay the exact initial LP split;
- attach both minting policies for pool creation and closure;
- update `pool_lovelace` with the ADA reserve for ADA pools, or calculate the complete output's required min-UTxO lovelace for token/token pools;
- select fresh UTxOs after each confirmed factory advance.

The web DEX workbench implements these flows and derives its scripts from the built `plutus.json`. A factory created before the three-party bootstrap version cannot be migrated in place: redeploy it and update the deployment record before enabling the three-party UI.

## Validation and security

Run:

```sh
aiken fmt .
aiken check --deny .
aiken build --out plutus.json .
```

The current Aiken unit suite exercises AMM arithmetic and exact token-pool value handling. Add full transaction-level bootstrap cases for FT-provider cancellation, missing LP or Team signature, reused role keys, wrong pair/reserve/buffer, wrong pool ID, wrong LP allocation, unauthorized factory advance, and a legacy deployment record before enabling the flow on Preprod.

This repository is not audited production code. Before real-value use, arrange independent audit, network-specific min-UTxO testing, key-management controls for the admin, monitoring for factory state/pool UTxOs, and a documented emergency pause/close process.
