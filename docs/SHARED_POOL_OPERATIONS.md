# Shared-pool Marketplace operations

This guide covers the registry-free shared quote pool used by `/marketplace`, `/team`, and `/reserves`. It does not replace the legacy oracle/USDM procedure in `contracts/marketplace/OPERATOR_RUNBOOK.md`.

## Scope and roles

| Role | Key requirement | Responsibility |
| --- | --- | --- |
| Marketplace seller | Owns the listed asset | Creates a direct listing or an Instant Sell request; may cancel an unaccepted request. |
| Marketplace buyer | Funds the quoted price | Buys a direct listing or pool-owned inventory. |
| Registry administrator | Registry admin key | Approves/revokes exact asset units used by the Team admission check. |
| Batcher | Quote-pool batcher key | Accepts eligible Instant Sell requests; selects bid and resale ask; signs the settlement transaction. |
| LP | Holds quote asset and LP tokens | Adds reserve or burns its LP position subject to pool rules. |

Keep these keys separate. The browser transaction builder does not replace the signer checks in the contracts, and no batcher private key belongs in browser storage or a `NEXT_PUBLIC_` environment variable. The Team console reads the exact-asset registry and fails closed for an unapproved request, but current shared-pool validators do not consume a registry reference; this is an operator control, not an on-chain permission check.

## What the pool tracks

The authenticated quote-pool UTxO contains an inline `QuotePoolDatum`. The operator console exposes the values that determine whether it is safe to accept another seller request:

| Value | Meaning |
| --- | --- |
| Pool cash | Current quote-asset balance in the pool UTxO. |
| Protected reserve | `min_cash_reserve`, which a settlement or LP withdrawal must not breach. |
| Available for bids | Pool cash less protected reserve; not a promise that a particular request can settle. |
| Open inventory value | Sum of asks for pool-owned listings that have not yet sold. |
| LP supply | Total outstanding claim token supply. |

The current Team health card presents the configured ADA pool in tADA. The liquidity workbench reads the quote asset from the live datum and uses its smallest units. Operators must not infer decimal places from a token ticker.

## Operator workflow

### 1. Read state before pricing

1. Connect the intended team wallet at `/team`.
2. Refresh shared-pool state and confirm the pool is live, not paused, and uses the expected deployment.
3. Record pool cash, protected reserve, available bidding balance, open inventory value, and LP supply.
4. Refresh the registry and confirm the exact `(policy ID, asset name)` is approved by the Team admission check. This does not replace a validator-level registry reference.
5. Refresh the Marketplace request queue immediately before building a transaction. A stale pool or request UTxO must be rebuilt.

### 2. Price and settle an Instant Sell request

An Instant Sell request is not a completed sale. The seller has escrowed an exact asset and set only a minimum payout.

1. Inspect the exact asset unit, quantity, requested minimum, and quote asset.
2. Confirm the asset approval and any off-chain price/risk approval required by the operating policy.
3. Choose a bid at or above the seller minimum and an ask for the pool-owned inventory listing.
4. Ensure the post-settlement pool quote balance remains at or above `min_cash_reserve` and that the ask/inventory exposure is acceptable.
5. Use the Team pricing queue with the batcher wallet. The transaction consumes the request and pool together, pays the seller, mints one inventory receipt, creates the pool-owned listing, and advances pool accounting atomically.
6. Wait for confirmation, refresh both Team and Marketplace, and archive the transaction hash, request out-ref, price source, bid, ask, and operator approval.

The on-chain path rejects an under-minimum seller payout, a pool transition that breaches its reserve rule, or a listing that is not bound to the pool inventory receipt. It does not independently reject an unregistered exact asset today; do not bypass the Team admission check or treat registry approval as a validator-enforced permission until the registry reference is integrated into the settlement contracts.

### 3. Manage liquidity

LP operations are available from `/team` or `/reserves`:

- **Add reserves:** deposits the configured quote asset and mints the calculated LP amount.
- **Remove reserves:** burns LP tokens and withdraws only from the amount above the protected reserve.

Do not try to change liquidity while open inventory exists. `inventory_value != 0` blocks add, remove, and close operations by design. Sell the inventory or use the documented inventory unwind procedure before changing LP state.

### 4. Marketplace operations

- Sellers use **List at my price** for a public direct listing. They control its price and can manage it under the direct-listing rules.
- Sellers use **Instant sell to pool** to set the minimum acceptable payout and wait for batcher settlement. They can cancel before the batcher accepts.
- Buyers may purchase either a direct listing or a pool-owned inventory listing. A pool-owned purchase returns payment to the pool and burns the corresponding inventory receipt.

## Reconciliation checklist

After every operator transaction, verify from the confirmed transaction and new UTxOs:

1. The expected pool identity token is in exactly one continuing pool UTxO.
2. The inline pool datum has the expected LP supply, reserve, and inventory value.
3. Seller or LP output matches the agreed amount and asset unit.
4. Inventory receipt mint or burn matches the inventory listing transition.
5. The exact asset unit in the listing/request is the one moved in the transaction.
6. The new pool cash remains at or above `min_cash_reserve` where that rule applies.
7. The record includes input references, signer role, transaction hash, price source, and approval reference.

## Failure handling

| Symptom | Safe response |
| --- | --- |
| Pool/request input changed | Refresh state and rebuild. Do not sign a transaction built against a stale UTxO. |
| Asset is not approved | Do not settle. Have the registry administrator approve the exact unit first. |
| Bid would breach protected reserve | Decline or reprice the request; do not override the reserve rule. |
| Open inventory prevents LP action | Complete or unwind all pool-owned listings, then retry with fresh state. |
| Connected wallet is not the batcher | Use the correct authorized wallet; do not attempt to proxy or export its signing key. |
| Legacy deployment data | Stop and verify the deployment manifest and script address before any transaction. |

## Security boundary

The shared pool is a coordinated service with a trusted pricing/batcher role. It is not a permissionless AMM, and the UI does not turn a batcher decision into an oracle. Treat price approvals, inventory valuation, key custody, and transaction reconciliation as operational controls. The contracts are not audited; complete transaction-level Preprod tests and independent review before real-value use.
