# UI modules

The primary navigation groups customer and operator work by task. Existing URLs remain available.

| Module | Routes | Responsibility |
| --- | --- | --- |
| Marketplace | `/marketplace` | Buy listings; owners can edit/cancel direct listings. Sale creation lives in Portfolio. |
| Protocol | `/protocol` | Wallet-free current-state statistics with per-source unavailable/partial indicators. |
| Portfolio | `/my-assets`, `/portfolio/positions`, `/portfolio/orders`, `/portfolio/reserves`, `/wallet`, `/history` | Wallet holdings, configured-deployment positions, owned listing management, shared reserve LP actions, wallet details and activity. |
| DEX | `/dex`, `/dex/liquidity`, `/dex/launch` | Swaps, LP deposits/withdrawals, and three-party bootstrap. |
| Operations | `/team`, `/team/inventory`, `/registry`, `/team/controls`, `/team/dex`, `/team/recovery`, `/wallets` | Request approval, operator prices and inventory limits, admission, pool configuration, factory administration, recovery, and deployment wallets. |
| Explore | `/assets`, `/asset-registry`, `/vault` | Public asset and state inspection. |

## Portfolio data

Holdings consolidate ADA, RWA/other native tokens, vault-linked fraction tokens, Reserves LP and DEX LP. LP classification uses the configured deployment's exact reserve token or DEX LP policy; open positions independently authenticate live pools. Unknown native tokens are not claimed to be verified RWA. Metadata and vault lookups may be incomplete; balances remain wallet base units. Open positions are also embedded below holdings, without adding them to wallet balances.

Sell / List supports a chosen quantity for NFTs and fungible tokens. Direct listings accept ADA (human ADA input) or an exact payment token (base-unit input). Instant Sell shows the published per-base-unit ADA bid and stores the resulting lot minimum on-chain. It is a cancellable request awaiting an operator, not immediate execution. Pending requests do not reserve capacity.

Open positions read vaults, direct listings, Instant Sell requests, bootstrap offers, DEX pools and the shared quote pool. Ownership comes from the connected wallet's payment key, recorded vault address, fraction holdings or LP holdings as appropriate. A recorded vault owner is not presented as having an unconditional redemption claim.

Each source reports its own failure; unavailable sources must not be interpreted as zero positions. The escrow ADA total includes owned listings, requests and FT-owner bootstrap offers. It excludes wallet cash, vault deposits and LP reserve value. Bootstrap ADA may become pool liquidity on acceptance; it is not always refunded.

This is a current-state view of configured deployments, not a historical indexer. LP-funded bootstrap transactions awaiting Team approval are not on-chain escrow positions until submitted. Activity history remains the existing limited classifier.

## DEX execution

Transaction previews show wallet balances, fee-inclusive spot-price impact, exact ratio-rounded deposits, expected LP mint/burn and both withdrawal assets. Pre-signing pool freshness checks reject a changed UTxO and require a new review. The direct AMM uses an exact state and quote; there is no configurable order-batcher slippage model.

DEX deployment and datum helpers live in `src/lib/protocol/dex-client.ts`; integer quote arithmetic lives in `src/lib/dex.ts`. Portfolio and DEX reuse the same pool reader and identity checks. Pending transaction hashes are shown with explorer and confirmation controls in the active page. These controls are not a persistent cross-page transaction center.

## Operator controls

Shared-pool controls permit an authorized administrator to update the protected reserve and pause flag, preserving identity, authorities, values and LP/inventory accounting. Factory controls modify only the pause flag and require a deployment matching the reviewed factory script. Pool creation and destruction are grouped under DEX administration.

The pricing queue reads published operator bids/asks, multiplies them by request quantity, shows remaining settlement cash, and rechecks active status, per-request quantity, total inventory cap, registry admission and the reserve floor before signing. An approval reference is required. After submission, the operator can download a JSON record containing price-book revision, input references, signer, prices, expected cash and transaction hash. The record is held in the current page session and must be archived by the operator; downloading does not prove confirmation.

`/team/inventory` publishes an ADA bid, ADA resale ask, maximum quantity per request, maximum total held inventory, and active flag for each exact asset ID. All quantities/prices are per base token unit, not per displayed decimal token or lot. The configured batcher signs a CIP-8 message; the API verifies the payment key, network, canonical payload, five-minute signing window and expected revision. No transaction or fee is needed to publish prices. These are off-chain operating settings, not a replacement validator/oracle. Existing listings retain their original on-chain asks; this release does not reprice existing pool inventory.

Price storage uses a private S3 object in production (`PRICE_BOOK_BUCKET`, `PRICE_BOOK_KEY`, `AWS_REGION`, server IAM `s3:GetObject`/`s3:PutObject`). Conditional writes prevent lost updates; enable bucket versioning for history. Without S3, development uses ignored `.data/instant-sell-preprod.json` with a local lock and atomic rename. Production fails closed if storage is not configured; never silently replace it with in-memory or browser-only settings. An abandoned development `.lock` after a process crash must be removed only after confirming no development writer is running. No bucket or cloud permissions are provisioned by this code change.

Confirmation checks have a 60-second timeout and retain the submitted hash for manual verification. A timeout does not imply transaction failure. Portfolio datum decoding isolates malformed outputs; listing discovery is paginated; zero-sided DEX withdrawals are blocked. Confirmed shared-pool controls refresh the sibling reserve workbench, which also rejects a stale input before signing.

Current Instant Sell validators do not enforce registry admission or the post-acquisition reserve floor. The Team UI performs those checks. Shared-pool closure, authority rotation, durable approval storage, and coordinated post-recovery delisting/liquidity retirement are not implemented by this reorganization.

New transaction paths require wallet-signed Preprod verification before operational use. No deployment or on-chain configuration is changed by reorganizing the UI.
