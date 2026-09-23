# UI modules

The primary navigation is **Marketplace, Swap, Portfolio, Create**. The More disclosure separates public protocol information from the Operator console. Operators retain their dedicated secondary navigation; these menus do not grant signing authority. The connected wallet disclosure contains wallet details, activity and an explicit Disconnect action, rather than disconnecting when its address is clicked.

Sections share a compact page heading, a persistent Preprod testnet indicator and keyboard skip-to-content support. Menus close on Escape, outside interaction and route changes. Narrow screens keep all four primary destinations visible and allow the section tabs to scroll without overflowing the page. No Explore entry is reintroduced.

Existing working URLs remain available. `/list` and the retired demo `/liquidate` redirect to `/my-assets`; `/reserves` redirects to `/portfolio/reserves` instead of exposing a duplicate workspace. The hard-coded liquidation balances and nonfunctional submission button were removed. Footer links point to protocol status and approved assets; placeholder Terms/Support links are not presented as working destinations.

| Module | Routes | Responsibility |
| --- | --- | --- |
| Marketplace | `/marketplace` | Buy listings; owners can edit/cancel direct listings. Sale creation lives in Portfolio. |
| Protocol (More) | `/protocol`, `/asset-registry`, `/vault` | Public statistics, admission and custody inspection. |
| Portfolio | `/my-assets`, `/portfolio/positions`, `/portfolio/orders`, `/portfolio/reserves`, `/wallet`, `/history` | Wallet holdings, configured-deployment positions, owned listing management, shared reserve LP actions, wallet details and activity. |
| DEX | `/dex`, `/dex/liquidity`, `/dex/launch` | Swaps, LP deposits/withdrawals, and three-party bootstrap. |
| Create | `/mint`, `/fractionalize` | Mint metadata-backed tokens or split/combine ownership. Minting does not imply registry admission or independent verification. |
| Operations | `/team`, `/team/inventory`, `/registry`, `/team/controls`, `/team/dex`, `/team/recovery`, `/wallets` | Request approval, operator prices and inventory limits, admission, pool configuration, three-party DEX bootstrap review, factory administration, recovery, and deployment wallets. |

## Portfolio data

Holdings consolidate ADA, RWA/other native tokens, vault-linked fraction tokens, Reserves LP and DEX LP. LP classification uses the configured deployment's exact reserve token or DEX LP policy; open positions independently authenticate live pools. Unknown native tokens are not claimed to be verified RWA. Metadata and vault lookups may be incomplete; balances remain wallet base units. Open positions have a dedicated page, linked alongside Listings & requests and Shared liquidity above holdings. The holdings page no longer mounts a second, full position scanner beneath the wallet assets.

Sell / List supports a chosen quantity for NFTs and fungible tokens. Direct listings accept ADA (human ADA input) or an exact payment token (base-unit input). Instant Sell shows the published per-base-unit ADA bid and stores the resulting lot minimum on-chain. It is a cancellable request awaiting an operator, not immediate execution. Pending requests do not reserve capacity.

Open positions read vaults, direct listings, Instant Sell requests, bootstrap offers, DEX pools and the shared quote pool. Ownership comes from the connected wallet's payment key, recorded vault address, fraction holdings or LP holdings as appropriate. A recorded vault owner is not presented as having an unconditional redemption claim.

Each source reports its own failure; unavailable sources must not be interpreted as zero positions. The escrow ADA total includes owned listings, requests and FT-owner bootstrap offers. It excludes wallet cash, vault deposits and LP reserve value. Bootstrap ADA may become pool liquidity on acceptance; it is not always refunded.

Listings & requests uses owner-specific instructions and omits the public pool-inventory book. Counts show an unavailable marker until wallet data loads successfully; refresh is disabled without a connection. The Marketplace retains its buying view and the “Trade RWA ownership” heading.

This is a current-state view of configured deployments, not a historical indexer. LP-funded bootstrap transactions awaiting Team approval are not on-chain escrow positions until submitted. Activity history remains the existing limited classifier.

## DEX execution

The swap page uses a compact From/To card with token selectors, wallet balances,
estimated output, and a direction switch. Selectors only expose existing direct
pool pairs; changing the pair or direction clears the input and quote. ADA is
entered in human tADA, while native tokens are explicitly shown in base units.
The single Swap action preserves balance checks, fee/impact disclosure, fresh
pool-state validation, and confirmation guards. Liquidity and administrator
workflows remain separate.

Transaction previews show wallet balances, fee-inclusive spot-price impact, exact ratio-rounded deposits, expected LP mint/burn and both withdrawal assets. Pre-signing pool freshness checks reject a changed UTxO and require a new review. The direct AMM uses an exact state and quote; there is no configurable order-batcher slippage model.

DEX deployment and datum helpers live in `src/lib/protocol/dex-client.ts`; integer quote arithmetic lives in `src/lib/dex.ts`. Portfolio and DEX reuse the same pool reader and identity checks. Pending transaction hashes are shown with explorer and confirmation controls in the active page. These controls are not a persistent cross-page transaction center.

## Operator controls

Shared-pool controls permit an authorized administrator to update the protected reserve and pause flag, preserving identity, authorities, values and LP/inventory accounting. Factory controls modify only the pause flag and require a deployment matching the reviewed factory script. DEX administration also hosts the three-party bootstrap workspace: before the Team creator can co-sign an LP request, the UI verifies the current factory and offer inputs, deterministic pool/LP identities, exact reserves and LP split, mint set, required signers, and that no Team-wallet UTxO is spent. Pool creation and destruction are grouped there as well.

Bootstrap approval additionally rejects Team or third-party collateral, unrelated inputs/outputs, governance actions, certificates, withdrawals, and reference inputs. It displays participant addresses, exact asset units and base-unit reserves, LP allocations, transaction hash and fee; acknowledgment is required. The current inputs are rechecked before signing and submission. Pending hashes and confirmation controls remain in the active page, not across reloads. Factory deployment/redeployment still uses the reviewed CLI, not a browser button; its public manifest is replaced only after confirmation, with a pending recovery record for interrupted runs.

The pricing queue reads published operator bids/asks, multiplies them by request quantity, shows remaining settlement cash, and rechecks active status, per-request quantity, total inventory cap, registry admission and the reserve floor before signing. An approval reference is required. After submission, the operator can download a JSON record containing price-book revision, input references, signer, prices, expected cash and transaction hash. The record is held in the current page session and must be archived by the operator; downloading does not prove confirmation.

`/team/inventory` publishes an ADA bid, ADA resale ask, maximum quantity per request, maximum total held inventory, and active flag for each exact asset ID. All quantities/prices are per base token unit, not per displayed decimal token or lot. The configured batcher signs a CIP-8 message; the API verifies the payment key, network, canonical payload, five-minute signing window and expected revision. No transaction or fee is needed to publish prices. These are off-chain operating settings, not a replacement validator/oracle. Existing listings retain their original on-chain asks; this release does not reprice existing pool inventory.

Price storage uses a private S3 object in production (`PRICE_BOOK_BUCKET`, `PRICE_BOOK_KEY`, `AWS_REGION`, server IAM `s3:GetObject`/`s3:PutObject`). Conditional writes prevent lost updates; enable bucket versioning for history. Without S3, development uses ignored `.data/instant-sell-preprod.json` with a local lock and atomic rename. Production fails closed if storage is not configured; never silently replace it with in-memory or browser-only settings. An abandoned development `.lock` after a process crash must be removed only after confirming no development writer is running. No bucket or cloud permissions are provisioned by this code change.

Confirmation checks have a 60-second timeout and retain the submitted hash for manual verification. A timeout does not imply transaction failure. Portfolio datum decoding isolates malformed outputs; listing discovery is paginated; zero-sided DEX withdrawals are blocked. Confirmed shared-pool controls refresh the sibling reserve workbench, which also rejects a stale input before signing.

Current Instant Sell validators do not enforce registry admission or the post-acquisition reserve floor. The Team UI performs those checks. Shared-pool closure, authority rotation, durable approval storage, and coordinated post-recovery delisting/liquidity retirement are not implemented by this reorganization.

New transaction paths require wallet-signed Preprod verification before operational use. No deployment or on-chain configuration is changed by reorganizing the UI.
