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
| `factory_state` | Holds the factory configuration, pool sequence, pause flag, and Team creator/admin. Normal creation and the constrained `AdvanceBootstrap` path both require that Team signature. |
| `bootstrap_offer` | Moves an FT-only offer to a funded escrow when its owner or a separate LP deposits the quote side. The owner can cancel only before funding; the Team later creates the pool. |
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

1. Derive the unparameterized `bootstrap_offer` address.
2. Derive `factory_state(admin, bootstrap_offer_address)`, then derive
   `factory_bootstrap` with that address, a funded seed UTxO, and a fixed
   factory-token name.
3. Derive the bootstrap policy ID. This gives the `factory_state_token`.
4. Derive `amm_pool(factory_state_token)` once. This is the address shared by
   all pools.
5. Derive `lp_policy(factory_state_token, amm_address)`, then derive
   `pool_factory(factory_state_token, amm_address, lp_policy_id)`.
6. Mint the factory-state NFT with `factory_bootstrap`, creating a
   `FactoryDatum` that records the pool-factory policy ID, admin key hash,
   `next_pool_id`, and pause state.
7. Create a standard admin pool with `Advance`, or create a three-party pool
   from a funded bootstrap escrow with `AdvanceBootstrap`. Pool NFTs
   and LP tokens use the 8-byte big-endian `next_pool_id` asset name.

Every initial-pool transaction is checked independently by `factory_state`,
`pool_factory`, and `lp_policy`, and must create a complete pool UTxO at the
single AMM address. A three-party creation is also checked by `bootstrap_offer`.

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

From the repository root, `npm run test:dex` executes the compiled bootstrap,
factory, pool-NFT and LP validators in a Lucid emulator with independently
funded participant wallets. It covers ADA and native-token quotes, distinct
funding and Team finalization, cancellation only before funding, and rejection
of reused signer identities. Aiken tests cover mismatched escrow recovery
(R04), missing signatures, and incorrect allocations. `npm run test:ui`
covers arithmetic and UI helpers.
These tests do not replace a real Eternl multi-wallet acceptance check.

## Preprod operator and UI

The repository root includes `scripts/dex-preprod.mjs`, which uses the funded
admin wallet configured in the ignored `.env.local` file. Its commands cover
the full lifecycle:

```sh
npm run dex:preprod -- status
npm run dex:preprod -- deploy
npm run dex:preprod -- redeploy
npm run dex:preprod -- confirm-deployment
npm run dex:preprod -- verify-deployment
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
Deployment keeps the active manifest unchanged until confirmation. Before
submission it writes a public recovery record to the ignored
`dex-deployment.preprod.pending.json`. If confirmation times out, run
`confirm-deployment` to verify and publish that same factory; do not redeploy
again. An unsigned/unsubmitted pending record must be investigated before
manual removal. Redeployment does not migrate old offers, pools, or funds;
the previous manifest is preserved under `supersedes` for recovery.
The admin script commands create and operate tADA/FT pools. The `/dex` UI derives the same scripts from the deployment record, reads live pools, signs normal operations with Eternl, and presents the three-party tADA/FT or USDCx/FT bootstrap flow. The same workspace is available in DEX Administration for the Team creator. The deployment record must include `bootstrapOfferAddress` before the UI will enable it.

## Security boundary

This is not audited production code. A deployment should have independent
review, transaction-level integration tests, min-UTxO checks for the selected
network, and an operational policy for the factory-admin key.

## Three-stage FT pool bootstrap

The FT provider creates an `OpenBootstrap` escrow with the exact FT quantity,
ADA buffer, quote asset and final reserve, and LP-share split. The owner may
cancel this open offer. The FT owner or a distinct LP signs a separate transaction that
consumes it and creates a `FundedBootstrap` UTxO at the same validator with
both reserves and the quote provider's address in its datum. Once funded, neither provider
can cancel or withdraw. Funds stay locked until the configured Team creator
acts; there is deliberately no timeout or recovery path.

The Team alone signs the later transaction that spends the funded escrow and
factory state. It creates the matching AMM UTxO, advances the factory sequence,
mints the matching pool NFT and complete LP supply, then pays the FT provider
and LP their declared allocations. No LP/Team witness handoff is needed.
Initial LP supply is `floor(sqrt(quote_reserve * FT_reserve))`; the owner share
is `floor(total_lp * owner_share_bps / 10_000)` and the LP receives the
remainder. When the share is 100%, only the FT owner may fund the quote side
and receives the entire LP supply. A split offer requires a distinct LP wallet.
The validator checks the exact escrow value and unchanged terms
when the LP funds it, and the pair, reserves, pool identity and LP allocation
when the Team creates the pool. The Team must have a distinct payment-key hash
from the FT owner and quote provider. Split offers also require the owner and
LP to have distinct payment-key hashes.

Open-offer cancellation requires the owner's signature and a full refund of
all escrowed assets, even if the offer has malformed terms or extra assets.
The funded state has no cancellation redeemer. Undecodable datums or a
mismatched owner remain unspendable; see `docs/ARCHITECTURE.md`.

| Quote pair | FT provider locks | LP provider deposits |
| --- | --- | --- |
| tADA / FT | FT amount and ADA buffer | Final ADA reserve minus the buffer |
| USDCx / FT | FT amount and fixed pool ADA buffer | Full USDCx reserve |

For a token/token pool, `pool_lovelace` remains the fixed ADA buffer through
swaps, liquidity updates, and closure; it is not the USDCx reserve.

`factory_state` requires the Team signature and a funded bootstrap input for
`AdvanceBootstrap`. The Team wallet pays the final transaction fee and the
minimum ADA for LP-token payout outputs. The UI shows the on-chain funded
escrow and its exact terms before the Team signs. It checks the network's
size-dependent minimum ADA for the open and funded escrows; automatic top-ups
would invalidate their exact values.

This validator change alters script hashes and the factory address. The
three-stage validator was deployed to Preprod in transaction
`345f7feb4e0a2141d52cc27824d6228cb5bbe937cf7a990a0be90cb28148e395`.
`verify-deployment` checks the confirmed factory NFT and datum against the
current compiled blueprint and manifest. Existing pools and offers did not
migrate automatically. The UI refuses signing against a deployment record
derived from older bytecode.
