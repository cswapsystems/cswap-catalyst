# CSWAP Catalyst

CSWAP Catalyst is a Cardano application for minting, fractionalizing, listing, and exchanging native assets. Wallets build and sign transactions locally through Eternl; browser code does not hold signing credentials.

## Product surfaces

Primary navigation is **Marketplace**, **Swap**, **Portfolio**, and **Create**, with public Protocol statistics and the Operator console in More. See [UI modules](docs/UI_MODULES.md) for route ownership, execution previews, operator controls, and remaining limitations.

- **Marketplace** (`/marketplace`) supports direct fixed-price listings and seller-only Instant Sell requests. Direct sellers set their own price. Instant Sell sellers set a minimum payout and wait for the shared-pool batcher to settle the request.
- **Shared-pool operations** (`/team`) gives the team a live view of settlement cash, protected reserve, open inventory value, LP supply, instant-sell pricing, registry approvals, and liquidity controls.
- **Fraction DEX** (`/dex`) runs a shared-address constant-product AMM. It supports normal admin-created tADA pools and a three-party bootstrap: an FT provider locks the FT side, a separate LP supplies tADA or USDCx, and the configured Team creator co-signs before the pool is created atomically and LP shares are split.
- **Asset registry** records separate exact-asset approvals. Owners create, view and cancel pending requests in Portfolio (`/portfolio/asset-requests`); the issuer reviews them at operator-gated `/registry`. Shared-pool acquisitions use on-chain price entries, not registry membership or an off-chain quantity/activity service.

Marketplace and DEX were freshly redeployed on Preprod with the security fixes on 2026-09-25. The manifests record the hardened validators; Marketplace includes all four reference scripts and a burn-capable identity with its public minting-seed reference. Signing still fails closed if configured identities do not match the blueprint. See the [deployment record](docs/PREPROD_REDEPLOYMENT_2026-09-25.md) and [Shared-pool operations](docs/SHARED_POOL_OPERATIONS.md). Old deployments and their funds were not migrated or made safe by redeployment.

**Indexer deployment is deferred by the owner.** Its authenticated watched-address configuration is prepared in the repository, but no indexer AWS changes are authorized for now. The project uses a different AWS account from the historical runbooks; the new account's deployment profile, region and stack are not yet recorded. See [off-chain deployment status](docs/OFFCHAIN_DEPLOYMENT.md).

## Documentation

- [Production architecture](docs/PRODUCTION_ARCHITECTURE.md) — product boundaries, trust roles, and deployment records.
- [Future multi-quote shared pools](docs/PRODUCTION_ARCHITECTURE.md#future-multiple-shared-pool-quote-assets) — deferred plan; the Preprod Marketplace reserve remains tADA-only.
- [Contract guide](docs/CONTRACTS_GUIDE.md) — validator-level state transitions and transaction-reading checklist.
- [Shared-pool operations](docs/SHARED_POOL_OPERATIONS.md) — Marketplace and Team-console operating procedure.
- [DEX contract guide](contracts/dex/README.md) and [DEX architecture](contracts/dex/docs/ARCHITECTURE.md) — AMM, bootstrap offer, and migration details.
- [Marketplace contract guide](contracts/marketplace/README.md) — registry, orderbook, quote-pool, and inventory rules.
- [Asset registry architecture](docs/ASSET_REGISTRY_ARCHITECTURE.md) and [registry operations](docs/ASSET_REGISTRY.md) — current exact-asset approval design and Preprod setup. [Future sharding plan](docs/FUTURE_SHARDED_REGISTRY.md) is a proposal, not a deployed contract.
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

Portfolio (`/my-assets`) is the entry point for selling/listing wallet assets; `/portfolio/orders` manages owned listings and `/portfolio/asset-requests` manages asset support requests. Marketplace is for buying. `/protocol` exposes public statistics; `/team/inventory` manages on-chain Instant Sell prices and inventory. The Operator Console, `/registry`, and all `/team/...` routes require an eligible connected operator/Team wallet. See [UI modules](docs/UI_MODULES.md).

The batcher posts executable buy/sell ratios on-chain at `/team/inventory`. Removing an entry stops new acquisitions for that exact asset. Sellers and the Team queue read the authenticated pool directly; no separate price-book service or S3 operator-limit storage is required. The on-chain reserve floor still applies, but there is no per-request or inventory quantity cap. Pending requests do not reserve capacity.

## Verification

The read-only GitHub Actions workflow at `.github/workflows/verify.yml` runs application lint/unit/build/browser checks, off-chain tests and strict Aiken checks on pushes and pull requests to `main` and `preprod`. It uses no wallet seed or cloud credentials. Branch protection or Amplify integration must still be configured before these checks can block a hosted deployment.

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
