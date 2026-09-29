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
| Asset requester | Creates a cancellable one-or-more-asset admission request | `/portfolio/asset-requests` |
| Batcher | Posts ratios, acquires Instant Sell listings and reprices inventory | `/team`, `/team/inventory` |
| Liquidity provider | Adds quote reserve, burns LP shares or completes final exit | `/portfolio/reserves` |
| Marketplace user | Creates/manages listings in Portfolio; buys public listings in Marketplace | `/my-assets`, `/portfolio/orders`, `/marketplace` |

The Team console is enabled only for configured operator/Team wallets, including direct `/team/...` visits. This client-side presentation guard is not an authorization boundary: builders, APIs and validators enforce the relevant signer. The console shows cash, available cash, inventory cost/ask/count and LP supply. Public registry requests are not operator-gated.

### Future: multiple shared-pool quote assets

Preprod currently runs **one Marketplace shared pool quoted in tADA** (`quoteUnit: lovelace` in `marketplace-deployment.preprod.json`). Inventory, posted prices, cash, LP shares and the protected reserve all belong to that pool. The tUSDC/tBTC DEX pairs are separate AMM pools; they are not additional Marketplace reserve quotes. The current Marketplace UI and deployment workflow should remain tADA-only.

Multi-quote Marketplace support is deferred. It would require a separately identified reserve pool for each quote asset, with its own state UTxO, LP token/supply, reserve floor, on-chain price entries and inventory receipts. An individual pool would still have one fixed quote asset; a price entry cannot choose its own quote. The pools may use a shared validator address, but their identity tokens must distinguish their UTxOs. Before enabling this, design pool discovery/routing and an explicit quote choice throughout Marketplace, Portfolio and Team; verify native-token ADA buffers and LP accounting; extend deployment manifests, indexing and tests; and plan how existing listings and LP positions remain tied to their original tADA pool. No automatic migration is implied.

## Fraction DEX

The DEX is a constant-product AMM separate from the shared quote pool. A factory-state NFT identifies a `FactoryDatum` containing the admin, deterministic pool-NFT policy, next pool ID, and paused flag. Each pool has a unique pool NFT and LP asset name but lives at the same `amm_pool` script address.

### Standard admin creation

The factory administrator can consume factory state with `Advance`, mint the next pool NFT and initial LP supply, and create a tADA/FT pool. This remains the regular controlled pool-creation route.

### Three-stage FT bootstrap

The FT owner creates a `BootstrapOfferDatum` and locks:

- the exact FT unit and quantity;
- quote asset and final reserve: tADA or USDCx;
- required ADA buffer for the escrow/pool UTxO;
- owner LP share in basis points.

The FT owner may set a 100% LP share and fund the quote side using the same address, or set a split share and let a different LP address fund it. The funding transaction consumes the open offer and creates a funded UTxO at the same escrow script with both reserves and the quote provider identity in its datum. The FT provider can cancel only before this funding transaction confirms. Neither provider can cancel or withdraw from the funded state; funds remain locked until the Team acts. The configured factory Team creator/admin then signs a separate transaction that consumes the funded escrow and factory state using `AdvanceBootstrap`, creates the deterministic AMM UTxO, mints the pool NFT and complete LP supply, and pays the fixed LP allocations. The Team key must differ from the funder and owner keys; split offers also require different owner and funder keys.

For a tADA pair, the owner buffer forms part of the final ADA reserve and the LP supplies the difference. For a USDCx/FT pair, the owner supplies the fixed ADA buffer while the LP supplies the full USDCx reserve. Token/token pools preserve that fixed ADA buffer across swaps, liquidity changes, and closure.

`AdvanceBootstrap` requires the factory-admin/Team signature and an input at the configured bootstrap-offer validator. That validator independently binds the funded escrow, asset pair, reserves, pool identity, LP split, LP funding signer, and Team finalization signer. The LP and Team sign different on-chain transactions, so there is no witness exchange.

## Deployment and migration

Marketplace and DEX deployments have independent public manifests. A manifest contains public addresses, policy IDs, and transaction identifiers; it must never contain wallet seeds, Blockfrost secrets, or batcher private keys.

Marketplace and DEX were freshly deployed on 2026-09-25; see the [deployment record](PREPROD_REDEPLOYMENT_2026-09-25.md). That DEX deployment uses the earlier single-settlement bootstrap. The local three-stage blueprint has different script hashes and requires a reviewed replacement before signing; old positions do not migrate automatically. A deployed script cannot be modified in place. Verify the hosted commit separately from on-chain deployment.

The current request-enabled registry was reused unchanged in the latest deployment. Older basic registries cannot gain `RegisterMany` in place; any replacement requires explicit approval and reviewed entries. Indexer cloud deployment is deferred, and the active AWS account/region/stack must be confirmed before resuming. Operator-limit S3 storage is a separate application requirement.

## Operational controls

- Use separate keys for registry admin, batcher, LP provider, factory admin, and recovery authority.
- Re-read mutable UTxOs immediately before signing; a pool or factory transaction built from a stale input must be rebuilt.
- Archive the submitted transaction hash, input references, expected datum transition, signer role, and source/approval for every operator price change.
- Do not place signing secrets in client-side configuration or browser storage.
- The contracts are not audited. Require transaction-level Preprod testing and independent review before mainnet or real-value use.
