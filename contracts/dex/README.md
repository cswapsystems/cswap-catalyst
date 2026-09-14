# Ebecca shared-address AMM DEX

This project implements a multi-pool constant-product AMM for Cardano. Every
pool created by a factory lives at one `amm_pool` validator address; pool
identity and configuration are carried by a singleton pool NFT and inline
datum, rather than by deploying a script per pair.

Detailed design, validator invariants, deployment sequencing, and operator guidance are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Validators

| Validator | Role |
| --- | --- |
| `factory_bootstrap` | One-shot policy that consumes a deployment seed and mints the permanent factory-state NFT. |
| `factory_state` | Holds the factory configuration, pool sequence, pause flag, and admin. It is consumed only to create a pool and read as a reference input for normal operations. |
| `amm_pool` | The one shared address for every pool. Validates swaps, proportional LP updates, and controlled full closure. |
| `lp_policy` | One shared LP policy. Each pool’s LP asset name is its deterministic pool ID. |
| `pool_factory` | One shared pool-NFT policy. It mints exactly one deterministic NFT for each factory-state advance. |

## Pool datum

```text
PoolDatum {
  pool_nft,
  asset_a, asset_b,
  lp_token,
  fee_numerator, fee_denominator,
  reserve_a, reserve_b,
  total_liquidity,
  pool_lovelace,
}
```

`pool_lovelace` is the exact lovelace held by a pool UTxO. It equals the ADA
reserve for ADA pairs and is the min-UTxO value for token/token pairs. The
AMM validates the complete UTxO value against this datum, so unrelated assets
cannot be trapped in or extracted from a pool.

## Lifecycle

1. Choose and fund one seed UTxO, then derive `factory_bootstrap` with that
   seed, the `factory_state` address, and a fixed factory-token name.
2. Derive the bootstrap policy ID. This gives the `factory_state_token`.
3. Derive `amm_pool(factory_state_token)` once. This is the address shared by
   all pools.
4. Derive `lp_policy(factory_state_token, amm_address)`, then derive
   `pool_factory(factory_state_token, amm_address, lp_policy_id)`.
5. Mint the factory-state NFT with `factory_bootstrap`, creating a
   `FactoryDatum` that records the pool-factory policy ID, admin key hash,
   `next_pool_id`, and pause state.
6. Create a pool by consuming the factory-state UTxO with `Advance` while
   minting the pool NFT and bootstrap LP supply. The pool NFT and LP token use
   the 8-byte big-endian encoding of `next_pool_id` as their asset name.

The initial-pool transaction is checked independently by `factory_state`,
`pool_factory`, and `lp_policy`, and must create a complete pool UTxO at the
single AMM address.

## Operations

- `Swap`: preserves LP supply and enforces the fee-adjusted constant-product
  maximum output.
- `AddLiquidity`: accepts only the current exact reserve ratio and requires
  matching LP minting capped at the provider's proportional share.
- `RemoveLiquidity`: requires matching LP burning and only permits a rounded
  down proportional withdrawal.
- `Close`: requires the factory admin signature, full LP-supply burn, pool-NFT
  burn, no successor pool NFT, and payment of both reserves plus all locked
  lovelace to the nominated recipient.

The factory state’s `paused` flag blocks new pools and normal AMM/LP actions.
An admin-signed close remains available for an orderly decommission.

## Asset convention

ADA uses an empty policy ID and asset name. Native asset names and policy IDs
in all datums are raw Cardano bytes, not display text.

## Build and test

```sh
aiken check --deny
aiken build
```

## Preprod operator and UI

The repository root includes `scripts/dex-preprod.mjs`, which uses the funded
admin wallet configured in the ignored `.env.local` file. Its commands cover
the full lifecycle:

```sh
npm run dex:preprod -- status
npm run dex:preprod -- pool <fraction-unit>
npm run dex:preprod -- collateral
npm run dex:preprod -- create <fraction-unit> <lovelace> <fraction-units>
npm run dex:preprod -- add <fraction-unit> <lovelace>
npm run dex:preprod -- swap <fraction-unit> <lovelace>
npm run dex:preprod -- swap-b <fraction-unit> <fraction-units>
npm run dex:preprod -- remove <fraction-unit> <lp-units>
npm run dex:preprod -- close <fraction-unit>
```

The public deployment addresses and confirmed lifecycle transaction IDs are
recorded in `dex-deployment.preprod.json`; it contains no signing material.
The `/dex` UI derives the same scripts from that deployment, reads live pools,
and signs create, destroy, add, remove, and two-way swap transactions with the
connected Eternl wallet.

## Security boundary

This is not audited production code. A deployment should have independent
review, transaction-level integration tests, min-UTxO checks for the selected
network, and an operational policy for the factory-admin key.
