# Shared-pool Marketplace operations

This guide implements [the contracts handover](MARKETPLACE_UI_HANDOVER.md). It supersedes the earlier ten-field pool / separate request workflow. The legacy oracle/USDM runbook is not this deployment.

## Deployment gate

The committed Preprod manifest still describes the previous contracts. New UI signing requires matching orderbook/pool addresses and matching LP/inventory policies derived from the supplied blueprint. Incompatible state is reported as unavailable, never as zero balances. Do not replace addresses without a reviewed deployment and asset migration plan.

Combined pool/listing transactions need reference scripts to fit ledger limits. After deploying reviewed scripts, add a top-level `referenceScripts` array to the marketplace deployment JSON: entries are exact `{ "txHash": "...", "outputIndex": 0 }` references. The reader fetches and verifies each script hash. Deploy references for orderbook, quote pool, LP policy and inventory policy; the UI does not publish them automatically.

The supplied `one_shot` pool identity policy has no burn path. Final LP exit cannot complete with that identity. The UI blocks starting final exit until a reviewed burn-capable identity artifact is integrated. The closing builders are emulator-tested with a **test-only** burn-capable identity, not evidence that the current deployment can close. No contract, identity or deployment is replaced by this UI change.

## Roles and pricing

- Sellers create Direct or InstantSell listings from Portfolio. Both can be edited/cancelled before settlement. InstantSell is a seller-owned marketplace listing, not publicly buyable.
- Buyers purchase Direct or QuotePool inventory listings.
- The batcher posts on-chain prices, acquires InstantSell listings and reprices inventory.
- The administrator changes reserve floor / pause state.
- LPs deposit, withdraw cash, or recover inventory during an already-started closing sequence.

On-chain price entries contain an exact asset plus positive integer buy and sell ratios. For quantity Q, bid and ask are respectively `floor(Q * numerator / denominator)` in quote-asset base units. Zero-rounded results are rejected. At most 50 unique assets may be priced. Removing an entry disables new acquisitions for that asset on-chain; existing inventory remains independently priced.

The separate off-chain controls retain maximum units per request, maximum units held in pool inventory and active status, as requested. They are signed operator messages, not validator guarantees. Existing storage price fields remain for compatibility but are never executable prices in the new flow. Pending listings reserve no capacity.

## Operator workflow

1. Connect the batcher at `/team/inventory`. Review pool identity, quote unit and current state.
2. Stage buy/sell ratios and sign the on-chain price update. Updates are allowed while paused, but not during closing.
3. Publish the separate off-chain limits and active switches. Neither the registry nor an oracle determines executable prices.
4. At `/team`, review pending listings, exact units, minimum payout, current bid/ask, cash and limits. Enter an approval reference.
5. Sign acquisition. The transaction consumes the seller listing and pool, pays the bid plus the old listing deposit to the seller, mints a receipt and creates inventory with stored acquisition cost. The operator funds the new inventory ADA deposit; pool quote cash falls by the bid only.
6. Confirm and archive the downloadable approval receipt. It records the pool/listing references, limits revision, prices and transaction hash; downloading alone does not prove confirmation.
7. Reprice existing inventory at `/team/inventory`. This atomically changes its ask and aggregate pool ask value, preserving acquisition cost.

Prices and the acquisition reserve floor are enforced on-chain. Quantity caps and active switches are additional off-chain controls. The queue remains visible if limit storage fails, but acquisition is disabled until limits and inventory can be verified.

## LP accounting

The 14-field pool tracks cash, protected reserve, LP supply, inventory **cost**, inventory **ask**, inventory **count**, posted prices and optional closing recipient.

- Deposits mint against cash plus acquisition cost, not resale asks; deposits can proceed with open inventory but not while paused/closing.
- Partial withdrawals pay only the burned fraction of cash above the reserve floor. They can proceed with open inventory or while paused. Burning shares gives up their inventory exposure.
- A rounded-zero cash withdrawal requires explicit acknowledgment.
- Permissionless top-ups add quote funds without LP shares; allowed while paused, not closing.
- A final LP exit burns all LP shares, pays available cash and records the exiting LP. Each remaining inventory listing is then returned with its ADA deposit to that LP, decrementing cost/ask/count and burning its receipt. The final transaction burns pool identity and returns remaining assets, including the reserve floor. **Starting this sequence remains gated by the identity-policy blocker above.**

Inventory return requires the exiting LP, not the batcher. Public inventory sales add ask payment and the inventory deposit to the pool and decrement all inventory accounting.

## Recovery and reconciliation

`/portfolio/orders` independently scans historical request escrows using the archived exact validator from revision `aadedf5`. It offers owner cancellation only, even when new deployment checks fail. This does not migrate old pool inventory or discover every historical deployment.

After confirmation verify pool identity, all three inventory counters, supply, seller/LP payments, receipt mint/burn and exact asset units. Rebuild if any referenced state changes. Session pending hashes have manual confirmation controls but are not a durable cross-page transaction journal.

Off-chain limits require private durable production storage: server-only `PRICE_BOOK_BUCKET`, `PRICE_BOOK_KEY` (default `preprod/instant-sell.json`) and `AWS_REGION`, narrowly scoped S3 GetObject/PutObject permissions and versioning. Revision-checked writes prevent lost updates. Development fallback uses ignored `.data/instant-sell-preprod.json`; production without S3 fails closed. No cloud resources are provisioned here.

Run `npm run test:marketplace` for compiled-validator emulator checks. Real wallet-signed Preprod acceptance and independent review remain necessary before operational use.
