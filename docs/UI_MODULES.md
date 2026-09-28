# UI modules

The primary navigation is **Marketplace, Swap, Portfolio, Create**. The More disclosure separates public protocol information from the Operator console. The console, direct `/team/...` routes, and `/registry` are enabled only for a connected configured operator/Team wallet (Marketplace batcher, registry issuer, Team recovery key or DEX administrator). Account changes and disconnection revoke UI access. This is a presentation guard, not a security boundary: APIs and validators independently verify signatures and authority. Asset owners create, view, and cancel their own pending approval requests at public Portfolio route `/portfolio/asset-requests`. The connected wallet disclosure contains wallet details, activity and an explicit Disconnect action, rather than disconnecting when its address is clicked.

Sections share a compact page heading, a persistent Preprod testnet indicator and keyboard skip-to-content support. Menus close on Escape, outside interaction and route changes. Narrow screens keep all four primary destinations visible and allow the section tabs to scroll without overflowing the page. No Explore entry is reintroduced.

Existing working URLs remain available. `/list` and the retired demo `/liquidate` redirect to `/my-assets`; `/reserves` redirects to `/portfolio/reserves` instead of exposing a duplicate workspace. The hard-coded liquidation balances and nonfunctional submission button were removed. Footer links point to protocol status and approved assets; placeholder Terms/Support links are not presented as working destinations.

| Module | Routes | Responsibility |
| --- | --- | --- |
| Marketplace | `/marketplace` | Buy listings; owners can edit/cancel direct listings. Sale creation lives in Portfolio. |
| Protocol (More) | `/protocol`, `/asset-registry`, `/vault` | Public statistics, admission and custody inspection. |
| Portfolio | `/my-assets`, `/portfolio/positions`, `/portfolio/orders`, `/portfolio/asset-requests`, `/portfolio/reserves`, `/wallet`, `/history` | Wallet holdings, positions, owned listings, owner asset-support requests, shared reserve LP actions, wallet details and activity. |
| DEX | `/dex`, `/dex/liquidity`, `/dex/launch` | Swaps, LP deposits/withdrawals, and three-party bootstrap. |
| Create | `/mint`, `/fractionalize` | Mint metadata-backed tokens or split/combine ownership. Minting does not imply registry admission or independent verification. |
| Operations | `/team`, `/team/inventory`, `/registry`, `/team/controls`, `/team/dex`, `/team/recovery`, `/wallets` | Issuer request approval, on-chain prices and inventory, pool configuration, three-party DEX bootstrap review, factory administration, recovery, and the connected Team wallet. |

## Portfolio data

Holdings consolidate ADA, RWA/other native tokens, vault-linked fraction tokens, Reserves LP and DEX LP. LP classification uses the configured deployment's exact reserve token or DEX LP policy; open positions independently authenticate live pools. Unknown native tokens are not claimed to be verified RWA. Metadata and vault lookups may be incomplete; balances remain wallet base units. Open positions have a dedicated page, linked alongside Listings & requests and Shared liquidity above holdings. The holdings page no longer mounts a second, full position scanner beneath the wallet assets.

Sell / List supports a chosen quantity for NFTs and fungible tokens. Direct listings accept ADA (human ADA input) or an exact payment token (base-unit input). Instant Sell derives its bid from the pool’s on-chain buy ratio in the configured quote asset and stores the resulting lot minimum on-chain. It is a cancellable request awaiting an operator, not immediate execution. Pending requests do not reserve capacity.

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

DEX deployment and datum helpers live in `src/lib/protocol/dex-client.ts`; integer quote arithmetic lives in `src/lib/dex.ts`. Portfolio and DEX reuse the same pool reader and identity checks. DEX pending transaction hashes still live in page state; its confirmation controls are not a persistent cross-page transaction center.

## Operator controls

Shared-pool controls permit an authorized administrator to update the protected reserve and pause flag, preserving identity, authorities, values and LP/inventory accounting. Factory controls modify only the pause flag and require a deployment matching the reviewed factory script. DEX administration also hosts the three-party bootstrap workspace: before the Team creator can co-sign an LP request, the UI verifies the current factory and offer inputs, deterministic pool/LP identities, exact reserves and LP split, mint set, required signers, and that no Team-wallet UTxO is spent. Pool creation and destruction are grouped there as well.

Bootstrap approval additionally rejects Team or third-party collateral, unrelated inputs/outputs, governance actions, certificates, withdrawals, and reference inputs. It displays participant addresses, exact asset units and base-unit reserves, LP allocations, transaction hash and fee; acknowledgment is required. The current inputs are rechecked before signing and submission. Pending hashes and confirmation controls remain in the active page, not across reloads. Factory deployment/redeployment still uses the reviewed CLI, not a browser button; its public manifest is replaced only after confirmation, with a pending recovery record for interrupted runs.

The pricing queue reads the 14-field pool’s on-chain buy/sell ratios and shows remaining cash. The price editor selects exact assets from the authenticated issuer registry and displays the pool's fixed quote asset; amounts are entered as quote paid/asked for an asset-base-unit quantity, then encoded as exact ratios. This selection is a UI safeguard: on-chain prices admit an exact asset, and the acquisition validator does not require registry membership. An approval reference is required, and a session-only JSON receipt records state references, prices and submitted hash.

`/team/inventory` stages exact-asset buy/sell ratios, displays their base-unit interpretation and publishes changes in a batcher-signed on-chain transaction. Drafts are labeled until confirmation. It also reprices existing inventory atomically. Removing an entry stops new acquisitions for that asset, but does not cancel pending requests or change existing inventory asks.

The separate off-chain price-book API and S3 operator-limit storage have been removed. The shared pool is the source of executable prices. There are no per-request or inventory quantity caps, so the batcher must review exposure before signing.

Confirmation checks have a 60-second timeout and retain the submitted hash for manual verification. A timeout does not imply transaction failure. Portfolio datum decoding isolates malformed outputs; listing discovery is paginated; zero-sided DEX withdrawals are blocked. Confirmed shared-pool controls refresh the sibling reserve workbench, which also rejects a stale input before signing.

Updated validators enforce posted prices and the acquisition reserve floor. Deposits use acquisition cost; partial withdrawals are cash-only and may proceed with inventory or while paused. The [confirmed fresh deployment](PREPROD_REDEPLOYMENT_2026-09-25.md) includes all four reference scripts and a burn-capable identity with its public minting seed recorded. Final exit is supported for that identity; missing/mismatched seed data or incompatible scripts still fail closed. Old mint-only identities were not upgraded. Legacy request cancellation uses an archived validator independently of the current deployment gate. Marketplace hook transactions now restore wallet-scoped submitted hashes after reload and block another submission until confirmation is checked; other flows, handoffs, input-aware retries and durable approvals still need work. See [Shared-pool operations](SHARED_POOL_OPERATIONS.md) for the closing sequence. Authority rotation and durable approval storage remain outstanding. Indexer deployment is explicitly deferred.

New transaction paths require wallet-signed Preprod verification before operational use. No deployment or on-chain configuration is changed by reorganizing the UI.
