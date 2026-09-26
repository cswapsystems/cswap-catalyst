# CSWAP Catalyst

CSWAP Catalyst is a Cardano application for minting, fractionalizing, listing, and exchanging native assets. Wallets build and sign transactions locally through Eternl; browser code does not hold signing credentials.

## Product surfaces

Primary navigation is **Marketplace**, **Swap**, **Portfolio**, and **Create**, with public Protocol statistics and the Operator console in More. See [UI modules](docs/UI_MODULES.md) for route ownership, execution previews, operator controls, and remaining limitations.

- **Marketplace** (`/marketplace`) supports direct fixed-price listings and seller-only Instant Sell requests. Direct sellers set their own price. Instant Sell sellers set a minimum payout and wait for the shared-pool batcher to settle the request.
- **Shared-pool operations** (`/team`) gives the team a live view of settlement cash, protected reserve, open inventory value, LP supply, instant-sell pricing, registry approvals, and liquidity controls.
- **Fraction DEX** (`/dex`) runs a shared-address constant-product AMM. It supports normal admin-created tADA pools and a three-party bootstrap: an FT provider locks the FT side, a separate LP supplies tADA or USDCx, and the configured Team creator co-signs before the pool is created atomically and LP shares are split.
- **Asset registry** (`/registry`) provides separate exact-asset approvals. New shared-pool acquisitions use on-chain price entries for admission, plus off-chain operator quantity/activity controls.

Marketplace and DEX were freshly redeployed on Preprod with the security fixes on 2026-09-25. The manifests record the hardened validators; Marketplace includes all four reference scripts and a burn-capable identity with its public minting-seed reference. Signing still fails closed if configured identities do not match the blueprint. See the [deployment record](docs/PREPROD_REDEPLOYMENT_2026-09-25.md) and [Shared-pool operations](docs/SHARED_POOL_OPERATIONS.md). Old deployments and their funds were not migrated or made safe by redeployment.

**Indexer deployment is deferred by the owner.** Its authenticated watched-address configuration is prepared in the repository, but no indexer AWS changes are authorized for now. The project uses a different AWS account from the historical runbooks; the new account's deployment profile, region and stack are not yet recorded. See [off-chain deployment status](docs/OFFCHAIN_DEPLOYMENT.md).

## Documentation

- [Production architecture](docs/PRODUCTION_ARCHITECTURE.md) — product boundaries, trust roles, and deployment records.
- [Contract guide](docs/CONTRACTS_GUIDE.md) — validator-level state transitions and transaction-reading checklist.
- [Shared-pool operations](docs/SHARED_POOL_OPERATIONS.md) — Marketplace and Team-console operating procedure.
- [DEX contract guide](contracts/dex/README.md) and [DEX architecture](contracts/dex/docs/ARCHITECTURE.md) — AMM, bootstrap offer, and migration details.
- [Marketplace contract guide](contracts/marketplace/README.md) — registry, orderbook, quote-pool, and inventory rules.
- [Asset registry](docs/ASSET_REGISTRY.md) — exact-asset approvals and Preprod setup.
- [Preprod deployment record](docs/PREPROD_REDEPLOYMENT_2026-09-25.md) — confirmed transactions, verification results and remaining acceptance work.
- [Preprod DEX test pools](docs/PREPROD_TEST_POOLS_2026-09-26.md) — live tADA/tUSDC and tADA/tBTC pool identities, reserves and swap checks.
- [Remaining issues](docs/REMAINING_ISSUES.md) — maintained engineering backlog; the earlier [handoff review](docs/DEVELOPER_HANDOFF_REVIEW.md) is historical evidence.
- [Amplify deployment](docs/AMPLIFY_DEPLOYMENT.md) and [off-chain status](docs/OFFCHAIN_DEPLOYMENT.md) — frontend build requirements and deferred indexer work.

The legacy RWA/USDM oracle-pool runbook remains at [contracts/marketplace/OPERATOR_RUNBOOK.md](contracts/marketplace/OPERATOR_RUNBOOK.md). It is not the operating guide for the registry-free shared quote pool used by `/marketplace` and `/team`.

## Local development

Install dependencies and start the app:

```sh
npm install
npm run dev
```

Open http://localhost:3000. Configure a supported Cardano network and Blockfrost access in `.env.local`; never put a wallet seed or batcher key in a `NEXT_PUBLIC_` variable.

Portfolio (`/my-assets`) is the entry point for selling/listing wallet assets; `/portfolio/orders` manages owned listings. Marketplace is for buying. `/protocol` exposes public statistics; `/team/inventory` manages operator Instant Sell prices, activity and quantity limits. The Operator Console and all `/team/...` routes require an eligible connected operator/Team wallet; `/registry` remains available for public approval requests. See [UI modules](docs/UI_MODULES.md).

Executable buy/sell ratios are posted on-chain by the batcher. Separate off-chain quantity/activity controls use an ignored development file locally and require private S3 storage in production (`PRICE_BOOK_BUCKET`, `PRICE_BOOK_KEY`, `AWS_REGION` and server IAM access). Publishing these controls requires a message signature from the configured batcher. Prices and reserve protection are enforced by validators; quantity caps and active switches are additional application controls. This S3 requirement is separate from the deferred projection indexer.

## Verification

```sh
npm run lint
node --experimental-strip-types --test tests/*.test.mjs
npm run test:offchain
npx tsc --noEmit
npm run build:preprod
npm run test:browser

# Run in each of contracts/marketplace and contracts/dex:
aiken check
```

For a verification build alongside an active dev server, set `CSWAP_NEXT_DIST_DIR=.next-review` for both `npm run build` and `npm run start`. This avoids two processes overwriting `.next`.

## Deployment boundary

A DEX deployment record binds its factory address to the compiled validator parameters. The current Preprod factory already supports three-party bootstrap. Legacy factories cannot be upgraded in place. For a future intentional replacement, review the blueprint and deployment record and obtain approval to spend test ADA before running:

```sh
npm run dex:preprod -- redeploy
```

This repository is not audited production code. Complete transaction-level Preprod tests and an independent security review before any mainnet or real-value use.

Deploying contracts does not publish the website. The configured hosting branch must separately receive the verified manifests and pass the Amplify build. Real Eternl account switching during transaction approval still needs manual acceptance testing; mock-wallet tests do not establish extension interoperability.
