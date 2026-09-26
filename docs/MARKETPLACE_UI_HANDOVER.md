# Marketplace UI handover: shared quote pool

This handover describes the implemented integration with the Marketplace validators in `contracts/marketplace`: fixed on-chain pool prices, Instant Sell orderbook listings, cost-basis LP accounting, cash-only exits and final-LP inventory recovery. The UI uses the 14-field pool schema and all three settlement variants. The [fresh Preprod deployment](PREPROD_REDEPLOYMENT_2026-09-25.md) matches the rebuilt scripts; old outputs were not migrated. Verify website publication separately.

## Implementation map

- `src/app/_components/marketplace-workbench.tsx` discovers and buys listings using shared decoders that distinguish Direct (0), Instant Sell (1) and pool-owned inventory (2).
- Done: `src/app/_components/portfolio-sale.tsx` creates Instant Sell as a seller-owned orderbook listing with `InstantSell { pool_token }` and the seller's minimum total payout in `price` (it previously submitted to the now-archived `pool_sell_request`).
- `src/app/_components/reserves-workbench.tsx` and `src/lib/protocol/shared-pool-client.ts` use the 14-field pool datum, cost-basis deposits, cash-only withdrawals and the recorded final-exit sequence.
- `src/app/_components/team-workbench.tsx` builds atomic `BatcherAcquire` transactions using posted prices, fresh pool state and off-chain quantity/activity limits. Registry membership is not an acquisition gate.
- Shared protocol helpers and marketplace tests enforce schema, identity and settlement assumptions; keep these synchronized with future blueprint changes.

The `pool_sell_request` source is archived and no longer in the blueprint. Owners cancel old request outputs through `/api/marketplace-recovery`, which serves the pinned compiled script.

## On-chain data layout

Aiken constructor indices are zero-based. `SimpleListingDatum` remains a seven-field constructor:

| Field | Value |
| --- | --- |
| 0 | seller address |
| 1 | seller payment key hash |
| 2 | settlement variant |
| 3 | RWA asset class |
| 4 | quantity |
| 5 | price asset |
| 6 | total price in base units |

`ListingSettlement` variants are now:

| Constructor | Variant | Fields |
| --- | --- | --- |
| 0 | `Direct` | none |
| 1 | `InstantSell` | pool token |
| 2 | `QuotePool` | pool token, inventory receipt token, acquisition cost |

For Instant Sell, field 6 is the seller's minimum acceptable total payout in the pool quote asset. For a pool-owned listing, field 6 is the current asking price. Its `QuotePool` settlement identifies the pool and one-unit inventory receipt and records acquisition cost independently of the ask.

`QuotePoolDatum` now has 14 fields:

| Field | Value |
| --- | --- |
| 0–5 | admin key, batcher key, pool token, LP token, inventory token, quote asset |
| 6 | list of exact-asset price entries (`asset`, `buy_price`, `sell_price`) |
| 7–9 | total LP supply, protected minimum cash reserve, paused flag |
| 10–12 | open inventory acquisition cost, aggregate current ask, listing count |
| 13 | optional closing LP (`None`, or `Some { recipient, provider_key }`) |

A price is a `Ratio { numerator, denominator }`; calculate quote amounts with integer division at the same base-unit precision used by the contracts. `inventory_cost` contributes to LP share value. `inventory_value` is an aggregate asking price for display and accounting; it is not reserve cash or a guaranteed sale value.

## Supported transaction flows

- **Create direct P2P listing:** escrow the asset and locked ADA at the listing validator; encode settlement constructor 0. The seller may update or cancel their listing.
- **Buy direct listing:** pay the listing's price asset and locked ADA to the seller, and deliver the listed quantity to the buyer.
- **Create Instant Sell listing:** use the same orderbook address and listing validator; encode constructor 1 with the pool identity and encode the seller's minimum payout in the listing price. Keep the listing visible as pending until it is filled or cancelled.
- **Batcher buys Instant Sell:** one transaction consumes exactly one seller listing and the pool, pays the posted bid (at least the seller minimum) plus the seller's locked ADA, mints one inventory receipt, and creates inventory at the posted ask. Pool cash falls by the bid only; the batcher funds the new inventory ADA buffer. Update cost, ask and count together; require the batcher signature and preserve the reserve floor.
- **Buy pool-owned listing:** one transaction consumes the orderbook listing and pool, pays the ask into pool reserves, transfers the RWA to the buyer, burns its inventory receipt, and reduces inventory aggregates.
- **Reprice pool-owned listing:** batcher-only transaction updates the listing ask and aggregate ask value; preserve its acquisition cost and all other listing identity fields.
- **Cancel listing:** seller-only; return asset and locked ADA. Pool-owned inventory cannot use ordinary seller cancellation.
- **LP deposit:** mint shares using incoming quote cash against pool equity (cash plus inventory acquisition cost). Deposits are permitted while inventory is open.
- **LP partial withdrawal:** burn shares and pay the pro-rata portion of quote cash above the protected reserve. This is cash-only and may return zero while still burning shares; show the preview and confirm explicitly before signing.
- **Final LP exit:** burn the remaining LP supply and withdraw available cash, starting the recorded close. For each remaining pool listing, a separate transaction burns its receipt and returns its RWA to the recorded LP. Complete the exit only after all inventory is returned and accounting reaches zero.
- **Permissionless reserve top-up:** add quote cash to the pool with no LP mint. Display this separately from an LP deposit.

## UI and transaction requirements

1. Maintain shared, tested decoders for the generated Aiken schemas. Validate constructor index, field count, asset identity, and optional values; skip unrelated outputs but surface malformed pool state instead of silently treating it as the old format.
2. Read buy/sell prices from pool datum, show the quote asset and base-unit conversion, and make clear that price changes affect future acquisitions. Each open pool listing keeps its own editable ask until repriced.
3. Before an Instant Sell is signed, fetch the current pool UTxO and posted buy price, show the minimum payout and indicative settlement, and make clear that only the batcher can fill it and the seller can cancel it. The transaction must still be validated on-chain against current reserve cash, price and listing state.
4. For LP actions, preview cash available above the protected reserve, shares burned, and expected cash payout. Never present inventory ask value as immediately withdrawable cash. Do not disable an LP action merely because `inventory_count` is nonzero.
5. Detect `closing != None` and show the recorded exiting LP and remaining listing count. Disable new deposits and acquisitions during close; require the recorded exiting LP for inventory recovery and completion as enforced by the validators.
6. Preserve the deployment compatibility gate. The current manifest includes matching reference scripts and the burn-capable pool identity's public minting seed. Reject absent or mismatched identities/scripts; older pool datums and mint-only identities do not upgrade automatically.

## Validation before release

- Maintain focused tests for datum constructor decoding and each settlement variant, especially constructor 1 versus 2.
- Exercise listing creation, buy, cancel, update, Instant Sell acquisition, pool purchase, repricing, partial LP withdrawal with open inventory, and the final-LP close sequence in the Lucid emulator.
- Run TypeScript lint/build and the relevant UI tests after updating builders. Run `aiken check` and `aiken build` against the exact blueprint intended for deployment.
- Compare derived validator addresses/script hashes with the configured Marketplace deployment before enabling signing actions.

The source of truth for validator roles is [`VALIDATOR_INVENTORY.md`](VALIDATOR_INVENTORY.md); contract behavior and operator sequencing are described in [`contracts/marketplace/README.md`](../contracts/marketplace/README.md) and [`SHARED_POOL_OPERATIONS.md`](SHARED_POOL_OPERATIONS.md).
