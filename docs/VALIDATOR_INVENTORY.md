# Validator inventory

This inventory is the authoritative source-level status for validators in this
repository. **Active** means the current web app, deployment scripts, or
supported transaction builders load the validator. A validator can still need a
fresh deployment before its newest source is live on Preprod.

The [2026-09-25 deployment record](PREPROD_REDEPLOYMENT_2026-09-25.md) records the hardened Marketplace/DEX deployments and reused request-enabled registry. Confirm blueprint/manifests after any subsequent artifact change; source renaming alone does not migrate outputs. The website's deployed commit must be verified separately.

## Active validator set

| Domain | Validator source | Purpose | Deployment note |
| --- | --- | --- | --- |
| Original assets and fractions | `contracts/minter/validators/multi_nft_policy.ak` | One-shot original RWA/NFT minting | Used by the minting flow. |
| Original assets and fractions | `contracts/minter/validators/ft_policy.ak` | Fraction-token mint/burn policy | Used with the fraction vault. |
| Original assets and fractions | `contracts/minter/validators/vault.ak` | Holds the original asset while fractions circulate; releases it only on complete combination | Used by My Assets fractionalize/combine flows. |
| Asset registry | `contracts/marketplace/validators/asset_registry.ak` | Team-managed approved asset registry | Current request-enabled registry was reused unchanged. |
| Asset registry | `contracts/marketplace/validators/asset_registry_request.ak` | Permissionless request UTxO consumed by Team approval/rejection | Derived from the configured request-enabled registry identities. |
| Shared pool | `contracts/marketplace/validators/one_shot.ak` | One-shot identity NFT policy for registry and pool state | Used by marketplace deployment scripts. |
| Shared pool | `contracts/marketplace/validators/shared_reserve_pool.ak` | Shared quote-asset reserve, LP accounting, and pool inventory state | Used by reserve and Team flows. |
| Shared pool | `contracts/marketplace/validators/pool_share_policy.ak` | Shared-pool ownership-share mint/burn policy | Used with `shared_reserve_pool`. |
| Shared pool | `contracts/marketplace/validators/pool_inventory_receipt_policy.ak` | Receipt policy for pool-owned inventory | Used for batcher acquisition, public sale, and LP wind-down. |
| Marketplace | `contracts/marketplace/validators/marketplace_listing_escrow.ak` | Registry-free listing escrow for direct, Instant Sell, and pool-owned inventory modes | Used by Marketplace listing and settlement flows. |
| FT DEX | `contracts/dex/validators/factory_bootstrap.ak` | One-shot factory-state NFT policy | Used once per DEX deployment. |
| FT DEX | `contracts/dex/validators/factory_state.ak` | Factory sequence, pause state, Team admin, and pool-creation authority | Confirmed fresh Preprod deployment supports three-party bootstrap. |
| FT DEX | `contracts/dex/validators/bootstrap_offer.ak` | FT-provider offer escrow and three-party acceptance checks | Current deployment includes hardened owner cancellation; older offers keep their old rules. |
| FT DEX | `contracts/dex/validators/amm_pool.ak` | Shared constant-product AMM pool address | Active pools retain their existing deployment validation rules. |
| FT DEX | `contracts/dex/validators/lp_policy.ak` | Per-pool LP token policy | Used by DEX pools. |
| FT DEX | `contracts/dex/validators/pool_factory.ak` | Deterministic DEX pool-NFT policy | Used by DEX pool creation/closure. |

## Archived source-only validators

The following files are moved to `retired-validators/` with an `.ak.disabled`
suffix. They are retained as source history but excluded from Aiken builds,
blueprints, APIs, deployment scripts, and the UI. They must not be selected for
new deployments.

| Domain | Archived validator |
| --- | --- |
| Marketplace legacy/oracle path | `registry`, `oracle`, `marketplace`, `p2p_listing` |
| Marketplace sharded prototype path | `registry_root`, `policy_shard`, `asset_shard`, `policy_shard_policy`, `asset_shard_policy`, `marketplace_sharded` |
| Marketplace legacy Instant Sell request | `pool_sell_request` (superseded by `marketplace_listing_escrow` `InstantSell` listings) |
| Minter prototype | `stt_one_shot` |

Owners can still cancel pre-existing legacy request and listing outputs from
Portfolio. Those recovery paths load pinned compiled scripts
(`contracts/marketplace/legacy-request-recovery.json` and
`legacy-p2p-listing-simple.json`), never the archived sources.

## Practical rule

Use the active source list above and the generated `plutus.json` files. Do not
derive a script from an archived file. Existing on-chain script addresses are
immutable: archiving a source file does not alter a previously deployed
contract, but the application deliberately no longer loads or presents those
obsolete validator families.
