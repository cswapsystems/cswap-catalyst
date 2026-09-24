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
| `bootstrap_offer` | Escrows an FT provider’s exact contribution and immutable pair terms until a distinct LP and the Team creator approve the same settlement transaction, or the provider cancels. |
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
   with an accepted `BootstrapOfferDatum` and `AdvanceBootstrap`. Pool NFTs
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
funded participant wallets. It covers ADA and native-token quotes, missing
and reused signer identities, incorrect allocations, cancellation ownership,
owner recovery of a mismatched-value escrow (R04),
minimum-buffer boundaries, standard admin creation, and stale or malicious
Team approval CBOR. `npm run test:ui` covers review arithmetic and UI helpers.
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

## Three-party FT pool bootstrap

The interim bootstrap path lets an FT provider, a separate liquidity provider,
and the configured Team creator launch a pair without handing either side to
the other. The FT provider submits a `BootstrapOfferDatum` that locks the exact
FT quantity and required ADA buffer. It also fixes the quote asset (tADA or
USDCx), final quote reserve, and initial LP-share split in basis points. The
contract requires three distinct payment-key hashes (FT provider, LP, and Team
creator), but cannot establish that those addresses are controlled by different
people; the FT provider may cancel until an approval transaction confirms.

A liquidity provider prepares the acceptance transaction, funds the quote side,
and signs it. The configured Team creator/admin reviews the immutable complete
transaction and adds the required second witness. It must create the matching
AMM UTxO, advance the factory sequence, mint the matching pool NFT and every
initial LP token, then pay the FT provider and LP their declared allocations.
Initial LP supply is `floor(sqrt(quote_reserve * FT_reserve))`; the owner share
is `floor(total_lp * owner_share_bps / 10_000)` and the LP receives the
remainder. The offer validator rejects a different asset pair, reserve, ADA
buffer, pool identity, LP allocation, missing LP signature, missing Team
signature, or reused FT-provider/LP/Team payment key. The FT provider can
cancel an unaccepted offer with its payment-key signature by returning the
entire escrowed value (every asset, at least the locked quantity) to its
datum address; cancellation does not depend on valid terms or an exact
datum/value match, so malformed escrows stay recoverable. Escrows with an
undecodable datum or a script/mismatched owner remain unspendable; see
`docs/ARCHITECTURE.md`.

| Quote pair | FT provider locks | LP provider supplies |
| --- | --- | --- |
| tADA / FT | FT amount and ADA buffer | Final ADA reserve minus the locked buffer |
| USDCx / FT | FT amount and the fixed pool ADA buffer | Full USDCx reserve |

For a token/token pool, `pool_lovelace` remains the fixed ADA buffer through
swaps, liquidity updates, and closure; it is not the USDCx reserve.

`factory_state` keeps its Team-admin signature requirement for normal Advance
and SetPaused operations. Its `AdvanceBootstrap` branch also requires that
Team signature and a matching bootstrap-offer input. This preserves the factory
approval boundary while the distinct LP funds the quote-side contribution.

This changes the deployed factory-state validator, its address derivation, and
its bootstrap-offer redeemer encoding. Build the contracts, review the new deployment record,
and run `npm run dex:preprod -- redeploy` on Preprod before using this UI. The
record must include `bootstrapOfferAddress`. Never use the new UI against a
legacy factory; it cannot be upgraded in place.

Before the Team creator signs an LP-provided bootstrap CBOR, the operator UI
must show a successful review of the current offer and factory inputs, the
deterministic pool NFT and LP token, the exact reserve and LP allocation, the
mint set, required signers, and the absence of Team-wallet inputs or collateral.
All funding and collateral must belong to the LP. The review is repeated
immediately before signing and final submission. Reject any
request with certificates, withdrawals, governance operations, unexpected
reference inputs or output destinations, an unexpected mint, or a changed
factory/offer reference. The validator also requires at least 2 tADA in the
offer escrow. This is a protocol floor, not a guarantee of the network's
size-dependent minimum UTxO. The UI defaults to 4 tADA and checks both the
escrow and resulting pool against current network parameters before signing;
automatic top-ups would invalidate the immutable exact-value datum. Increase
the buffer or ADA reserve if this check fails. A submitted hash remains visible with a confirmation
check and duplicate actions disabled until it confirms in the active page.
