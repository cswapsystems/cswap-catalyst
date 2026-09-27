# CSWAP production architecture

## Protocol boundaries

CSWAP has three separate on-chain systems. Their assets, price authority, LP tokens, and deployment records must never be conflated.

| System | User surface | Price authority | State model |
| --- | --- | --- | --- |
| Fractionalization | `/mint`, `/fractionalize` | None | A vault holds one original asset while a fixed FT supply circulates. |
| Marketplace shared pool | `/marketplace`, `/my-assets`, `/team`, `/portfolio/reserves` | Team batcher posts on-chain buy/sell ratios | A reserve pool holds cash, LP supply, protected reserve, inventory cost/ask/count and closing state. |
| Fraction DEX | `/dex` | AMM reserve ratio | A factory authenticates many pool UTxOs at one shared AMM address. |

## Marketplace and shared-pool settlement

The Marketplace has two intentionally distinct seller experiences:

1. **Direct listing.** The seller escrows an exact asset and selects its fixed public price. A buyer pays that price directly to the seller.
2. **Instant Sell.** The seller escrows an exact asset with a cancellable minimum payout. The asset is not publicly purchasable until the authorized batcher accepts it from the shared pool.

The shared-pool path is a quoted settlement service, not an AMM:

```text
seller -> InstantSell listing -> batcher settlement -> pool-owned inventory -> buyer
                                      |                    |
                                      +-- cash debit        +-- cash return on sale
```

The `shared_reserve_pool` and `marketplace_listing_escrow` validators use the pool's posted exact-asset buy/sell ratios, not registry membership. There is no separate off-chain price book or quantity-cap service. Acquisition pays the posted bid (at least the seller minimum) and returns the seller's listing ADA; the batcher funds the new inventory ADA buffer. The transaction mints one receipt and updates inventory cost, ask and count. A later buyer burns the receipt and returns the listing payment and inventory ADA to the pool. Direct listings remain registry-free.

### Permissionless asset-admission requests

Any user may submit a cancellable UTxO containing one or more exact asset IDs
to the shared-pool admission registry. The asset_registry_request validator
binds the request to the basic registry address, identity token, and issuer
key. Team approval consumes the request and registry UTxOs together, creates
the only allowed batched registry transition, and refunds the request deposit.
The Team may reject, and the requester may cancel. No request automatically
admits an asset.

    requester -> request UTxO (assets + refundable ADA)
                           | Team issuer approves
                           v
              request UTxO + registry UTxO consumed together
                           +--> next registry state contains all requested IDs
                           +--> request deposit returns to requester

This is an auditable intake/approval record, not a replacement for due diligence.
Neither the current acquisition builder nor its validators use registry membership
as an admission gate. Posted on-chain prices admit an asset to the shared pool;
registry approval is a separate record and does not automatically post a price.

The 14-field reserve datum tracks identities, authorities, quote asset, posted prices, LP supply, protected reserve, pause state, inventory cost/ask/count and optional closing LP. Deposits use cash plus acquisition cost and can proceed with inventory, but not while paused/closing. Partial withdrawals pay only the burned share of cash above the reserve and can proceed with inventory or while paused. Early leavers give up inventory exposure. Final exit burns all remaining shares, records the exiting LP, returns inventory one listing at a time, then burns the pool identity and returns remaining reserve assets. The current deployment supports this burn; old mint-only identities do not.

### Team roles and UI

| Role | On-chain authority | Primary UI |
| --- | --- | --- |
| Registry administrator | Approves or revokes exact asset units in the independent approval record | `/registry` |
| Asset requester | Creates a cancellable one-or-more-asset admission request | `/registry` |
| Batcher | Posts ratios, acquires Instant Sell listings and reprices inventory | `/team`, `/team/inventory` |
| Liquidity provider | Adds quote reserve, burns LP shares or completes final exit | `/portfolio/reserves` |
| Marketplace user | Creates/manages listings in Portfolio; buys public listings in Marketplace | `/my-assets`, `/portfolio/orders`, `/marketplace` |

The Team console is enabled only for configured operator/Team wallets, including direct `/team/...` visits. This client-side presentation guard is not an authorization boundary: builders, APIs and validators enforce the relevant signer. The console shows cash, available cash, inventory cost/ask/count and LP supply. Public registry requests are not operator-gated.

## Fraction DEX

The DEX is a constant-product AMM separate from the shared quote pool. A factory-state NFT identifies a `FactoryDatum` containing the admin, deterministic pool-NFT policy, next pool ID, and paused flag. Each pool has a unique pool NFT and LP asset name but lives at the same `amm_pool` script address.

### Standard admin creation

The factory administrator can consume factory state with `Advance`, mint the next pool NFT and initial LP supply, and create a tADA/FT pool. This remains the regular controlled pool-creation route.

### Interim three-party FT bootstrap

The FT owner creates a `BootstrapOfferDatum` and locks:

- the exact FT unit and quantity;
- quote asset and final reserve: tADA or USDCx;
- required ADA buffer for the escrow/pool UTxO;
- owner LP share in basis points.

A different LP address prepares and signs the acceptance transaction, funding the quote side. The configured factory Team creator/admin must review and co-sign that exact completed transaction before submission. It consumes the offer and factory state using `AdvanceBootstrap`, creates the deterministic AMM UTxO, mints the pool NFT and complete LP supply, and pays the fixed LP allocations to the FT provider and LP. The FT provider can cancel an unaccepted offer with its stored payment-key signature. The script enforces distinct payment-key hashes, not distinct legal identities.

For a tADA pair, the owner buffer forms part of the final ADA reserve and the LP supplies the difference. For a USDCx/FT pair, the owner supplies the fixed ADA buffer while the LP supplies the full USDCx reserve. Token/token pools preserve that fixed ADA buffer across swaps, liquidity changes, and closure.

`AdvanceBootstrap` requires the factory-admin/Team signature and an input at the configured bootstrap-offer validator. That validator independently binds the asset pair, reserves, pool identity, LP split, LP signer, and Team signer.

## Deployment and migration

Marketplace and DEX deployments have independent public manifests. A manifest contains public addresses, policy IDs, and transaction identifiers; it must never contain wallet seeds, Blockfrost secrets, or batcher private keys.

Marketplace and DEX were freshly deployed on 2026-09-25; see the [deployment record](PREPROD_REDEPLOYMENT_2026-09-25.md). The manifests match the hardened validators and the DEX includes three-party bootstrap. A deployed script cannot be modified in place. Future incompatible blueprint changes must disable signing until an intentional replacement is confirmed; old positions do not migrate automatically. Verify the hosted commit separately from on-chain deployment.

The current request-enabled registry was reused unchanged in the latest deployment. Older basic registries cannot gain `RegisterMany` in place; any replacement requires explicit approval and reviewed entries. Indexer cloud deployment is deferred, and the active AWS account/region/stack must be confirmed before resuming. Operator-limit S3 storage is a separate application requirement.

## Operational controls

- Use separate keys for registry admin, batcher, LP provider, factory admin, and recovery authority.
- Re-read mutable UTxOs immediately before signing; a pool or factory transaction built from a stale input must be rebuilt.
- Archive the submitted transaction hash, input references, expected datum transition, signer role, and source/approval for every operator price change.
- Do not place signing secrets in client-side configuration or browser storage.
- The contracts are not audited. Require transaction-level Preprod testing and independent review before mainnet or real-value use.
