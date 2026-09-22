# CSWAP production architecture

## Protocol boundaries

CSWAP has three separate on-chain systems. Their assets, price authority, LP tokens, and deployment records must never be conflated.

| System | User surface | Price authority | State model |
| --- | --- | --- | --- |
| Fractionalization | `/mint`, `/fractionalize` | None | A vault holds one original asset while a fixed FT supply circulates. |
| Marketplace shared pool | `/marketplace`, `/team`, `/reserves` | Team batcher sets bid and resale ask | A quote pool holds settlement cash, LP supply, protected reserve, and inventory value. |
| Fraction DEX | `/dex` | AMM reserve ratio | A factory authenticates many pool UTxOs at one shared AMM address. |

## Marketplace and shared-pool settlement

The Marketplace has two intentionally distinct seller experiences:

1. **Direct listing.** The seller escrows an exact asset and selects its fixed public price. A buyer pays that price directly to the seller.
2. **Instant Sell.** The seller escrows an exact asset with a cancellable minimum payout. The asset is not publicly purchasable until the authorized batcher accepts it from the shared pool.

The shared-pool path is a quoted settlement service, not an AMM:

```text
seller -> pool-sell request -> batcher settlement -> pool-owned inventory -> buyer
                                      |                    |
                                      +-- cash debit        +-- cash return on sale
```

The Team console reads the exact-asset registry before it builds an Instant Sell settlement, while direct listings remain registry-free. The current `quote_pool` and `pool_sell_request` validators do not consume a registry reference, so registry admission is a fail-closed client/operator control rather than an on-chain settlement guarantee. The batcher pays at least the seller minimum, chooses the actual bid and inventory ask, and mints one inventory receipt. The receipt and `inventory_value` bind the pool-owned listing to the pool. A later buyer burns that receipt and returns the listing payment to the pool.

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

This is an auditable intake/approval boundary, not a replacement for due
diligence. Current shared-pool validators still do not reference the basic
registry, so approval remains an on-chain-authenticated Team admission record
and fail-closed operator check until those settlement validators are upgraded.

The quote-pool datum tracks the quote asset, total LP supply, protected minimum cash reserve, paused state, and aggregate ask value of open inventory. LP add, remove, and close are blocked while `inventory_value != 0`; this avoids changing LP claims while assets already purchased by the pool remain for sale.

### Team roles and UI

| Role | On-chain authority | Primary UI |
| --- | --- | --- |
| Registry administrator | Approves or revokes exact asset units used by the Team admission check | `/registry` |
| Asset requester | Creates a cancellable one-or-more-asset admission request | `/registry` |
| Batcher | Settles Instant Sell requests and sets the pool resale ask | `/team` pricing queue |
| Liquidity provider | Adds quote reserve or burns LP tokens for allowed withdrawals | `/team` or `/reserves` |
| Marketplace user | Creates/cancels direct listings or Instant Sell requests; buys inventory | `/marketplace` |

The Team console is an operator workspace, not an unrestricted admin override. The connected payment key must satisfy the batcher/admin conditions enforced by the transaction builders and validators. It displays pool cash, cash available above the protected reserve, open inventory value, and LP supply so pricing decisions have context.

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

The three-party bootstrap changes the `factory_state` and bootstrap-offer validator scripts and the offer-action encoding. A deployed factory cannot be modified in place. A new Preprod deployment must be created with the reviewed blueprint and a manifest containing `bootstrapOfferAddress`. Until that migration, the UI keeps factory creation and three-party bootstrap unavailable, but active pools whose AMM address and policy IDs match the reviewed blueprint remain swappable and support normal LP transitions.

The asset-admission request flow adds RegisterMany to the basic registry and a parameterized asset_registry_request validator. It changes the basic registry script hash, so existing basic-registry deployments require an intentional redeployment and reviewed-entry migration before this interface is enabled.

## Operational controls

- Use separate keys for registry admin, batcher, LP provider, factory admin, and recovery authority.
- Re-read mutable UTxOs immediately before signing; a pool or factory transaction built from a stale input must be rebuilt.
- Archive the submitted transaction hash, input references, expected datum transition, signer role, and source/approval for every operator price change.
- Do not place signing secrets in client-side configuration or browser storage.
- The contracts are not audited. Require transaction-level Preprod testing and independent review before mainnet or real-value use.
