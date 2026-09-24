# Marketplace UI handover: shared quote pool

This handover describes the frontend work needed to integrate with the updated Marketplace validators in `contracts/marketplace`. The contract sources and blueprint now represent fixed on-chain pool prices, Instant Sell listings on the P2P orderbook, cost-basis LP accounting, cash-only exits, and final-LP inventory recovery. The existing UI still encodes and decodes the earlier request-queue and 10-field pool format; it is not compatible yet.

## Files that need frontend updates

- `src/app/_components/marketplace-workbench.tsx` discovers and buys listings. Its decoder treats settlement constructor 1 as pool inventory. In the updated schema constructor 1 is Instant Sell; pool-owned inventory is constructor 2. Its buy path and listing management redeemers must distinguish all three settlement variants.
- Done: `src/app/_components/portfolio-sale.tsx` creates Instant Sell as a seller-owned orderbook listing with `InstantSell { pool_token }` and the seller's minimum total payout in `price` (it previously submitted to the now-archived `pool_sell_request`).
- `src/app/_components/reserves-workbench.tsx` and `src/lib/protocol/shared-pool-client.ts` still parse a 10-field pool datum and block all liquidity actions when inventory is open. The current datum has 14 fields and allows deposits and cash-only LP withdrawals while listings remain open.
- `src/app/_components/team-workbench.tsx` currently operates the old request settlement flow. Replace settlement with the atomic P2P `BatcherAcquire` flow; keep request cancellation support only for legacy request UTxOs.
- Review `src/app/_components/team-console.tsx`, `src/lib/protocol/inventory.ts`, and marketplace UI tests for old pool field positions and settlement constructor assumptions.

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

## Transaction flows to implement

- **Create direct P2P listing:** escrow the asset and locked ADA at the listing validator; encode settlement constructor 0. The seller may update or cancel their listing.
- **Buy direct listing:** pay the listing's price asset and locked ADA to the seller, and deliver the listed quantity to the buyer.
- **Create Instant Sell listing:** use the same orderbook address and listing validator; encode constructor 1 with the pool identity and encode the seller's minimum payout in the listing price. Keep the listing visible as pending until it is filled or cancelled.
- **Batcher buys Instant Sell:** one transaction consumes the pool and seller listing, pays the seller at least the listing minimum from available quote cash, mints one inventory receipt, and creates the pool-owned orderbook listing at the batcher's selected ask. Update pool cost, ask, and count aggregates in that transaction. This action requires the configured batcher signature.
- **Buy pool-owned listing:** one transaction consumes the orderbook listing and pool, pays the ask into pool reserves, transfers the RWA to the buyer, burns its inventory receipt, and reduces inventory aggregates.
- **Reprice pool-owned listing:** batcher-only transaction updates the listing ask and aggregate ask value; preserve its acquisition cost and all other listing identity fields.
- **Cancel listing:** seller-only; return asset and locked ADA. Pool-owned inventory cannot use ordinary seller cancellation.
- **LP deposit:** mint shares using incoming quote cash against pool equity (cash plus inventory acquisition cost). Deposits are permitted while inventory is open.
- **LP partial withdrawal:** burn shares and pay the pro-rata portion of quote cash above the protected reserve. This is cash-only and may return zero while still burning shares; show the preview and confirm explicitly before signing.
- **Final LP exit:** burn the remaining LP supply and withdraw available cash, starting the recorded close. For each remaining pool listing, a separate transaction burns its receipt and returns its RWA to the recorded LP. Complete the exit only after all inventory is returned and accounting reaches zero.
- **Permissionless reserve top-up:** add quote cash to the pool with no LP mint. Display this separately from an LP deposit.

## UI and transaction requirements

1. Replace positional datum assumptions with shared, tested decoders for the new generated Aiken schemas. Validate constructor index, field count, asset identity, and optional values; skip unrelated outputs but surface malformed pool state instead of silently treating it as the old format.
2. Read buy/sell prices from pool datum, show the quote asset and base-unit conversion, and make clear that price changes affect future acquisitions. Each open pool listing keeps its own editable ask until repriced.
3. Before an Instant Sell is signed, fetch the current pool UTxO and posted buy price, show the minimum payout and indicative settlement, and make clear that only the batcher can fill it and the seller can cancel it. The transaction must still be validated on-chain against current reserve cash, price and listing state.
4. For LP actions, preview cash available above the protected reserve, shares burned, and expected cash payout. Never present inventory ask value as immediately withdrawable cash. Do not disable an LP action merely because `inventory_count` is nonzero.
5. Detect `closing != None` and show the recorded exiting LP and remaining listing count. Disable new LP deposits and new acquisitions during close; expose return-inventory and complete-exit actions only to the recorded LP/batcher path required by the validators.
6. Treat the current UI/deployment as schema-incompatible until the new builders and readers are implemented and the pool/orderbook scripts are deployed from the updated blueprint. Existing deployed pool datums do not gain fields automatically; plan migration or a fresh deployment and update address/configuration data deliberately.

## Validation before release

- Add focused tests for datum constructor decoding and each settlement variant, especially constructor 1 versus 2.
- Exercise listing creation, buy, cancel, update, Instant Sell acquisition, pool purchase, repricing, partial LP withdrawal with open inventory, and the final-LP close sequence in the Lucid emulator.
- Run TypeScript lint/build and the relevant UI tests after updating builders. Run `aiken check` and `aiken build` against the exact blueprint intended for deployment.
- Compare derived validator addresses/script hashes with the configured Marketplace deployment before enabling signing actions.

The source of truth for validator roles is [`VALIDATOR_INVENTORY.md`](VALIDATOR_INVENTORY.md); contract behavior and operator sequencing are described in [`contracts/marketplace/README.md`](../contracts/marketplace/README.md) and [`SHARED_POOL_OPERATIONS.md`](SHARED_POOL_OPERATIONS.md).
