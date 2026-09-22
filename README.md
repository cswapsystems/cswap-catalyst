# CSWAP Catalyst

CSWAP Catalyst is a Cardano application for minting, fractionalizing, listing, and exchanging native assets. Wallets build and sign transactions locally through Eternl; browser code does not hold signing credentials.

## Product surfaces

The UI groups work into **Portfolio**, **DEX**, and **Operations**, with Marketplace, Mint, and Explore as separate entry points. See [UI modules](docs/UI_MODULES.md) for route ownership, execution previews, operator controls, and remaining limitations.

- **Marketplace** (`/marketplace`) supports direct fixed-price listings and seller-only Instant Sell requests. Direct sellers set their own price. Instant Sell sellers set a minimum payout and wait for the shared-pool batcher to settle the request.
- **Shared-pool operations** (`/team`) gives the team a live view of settlement cash, protected reserve, open inventory value, LP supply, instant-sell pricing, registry approvals, and liquidity controls.
- **Fraction DEX** (`/dex`) runs a shared-address constant-product AMM. It supports normal admin-created tADA pools and a three-party bootstrap: an FT provider locks the FT side, a separate LP supplies tADA or USDCx, and the configured Team creator co-signs before the pool is created atomically and LP shares are split.
- **Asset registry** (`/registry`) supplies the Team UI exact-asset admission check before it builds a shared-pool Instant Sell settlement. Current shared-pool validators do not yet authenticate that registry on-chain.

## Documentation

- [Production architecture](docs/PRODUCTION_ARCHITECTURE.md) — product boundaries, trust roles, and deployment records.
- [Contract guide](docs/CONTRACTS_GUIDE.md) — validator-level state transitions and transaction-reading checklist.
- [Shared-pool operations](docs/SHARED_POOL_OPERATIONS.md) — Marketplace and Team-console operating procedure.
- [DEX contract guide](contracts/dex/README.md) and [DEX architecture](contracts/dex/docs/ARCHITECTURE.md) — AMM, bootstrap offer, and migration details.
- [Marketplace contract guide](contracts/marketplace/README.md) — registry, orderbook, quote-pool, and inventory rules.
- [Asset registry](docs/ASSET_REGISTRY.md) — exact-asset approvals and Preprod setup.

The legacy RWA/USDM oracle-pool runbook remains at [contracts/marketplace/OPERATOR_RUNBOOK.md](contracts/marketplace/OPERATOR_RUNBOOK.md). It is not the operating guide for the registry-free shared quote pool used by `/marketplace` and `/team`.

## Local development

Install dependencies and start the app:

```sh
npm install
npm run dev
```

Open http://localhost:3000. Configure a supported Cardano network and Blockfrost access in `.env.local`; never put a wallet seed or batcher key in a `NEXT_PUBLIC_` variable.

Portfolio (`/my-assets`) is the entry point for selling/listing wallet assets. Marketplace is for buying and managing existing listings. `/protocol` exposes public statistics; `/team/inventory` manages operator Instant Sell prices, activity and quantity limits. See [UI modules](docs/UI_MODULES.md).

Operator prices use an ignored development file locally. Production requires private S3 storage configured with `PRICE_BOOK_BUCKET`, `PRICE_BOOK_KEY` and `AWS_REGION`, plus server IAM access. Publishing requires a message signature from the configured batcher wallet. Price/quantity rules remain application-level operating controls; no validator is upgraded by this change.

## Verification

```sh
npm run lint
npm run test:ui
npx tsc --noEmit
npm run build

cd contracts/dex
aiken check --deny .
aiken build --out plutus.json
```

For a verification build alongside an active dev server, set `CSWAP_NEXT_DIST_DIR=.next-review` for both `npm run build` and `npm run start`. This avoids two processes overwriting `.next`.

## Deployment boundary

A DEX deployment record binds its factory address to the compiled validator parameters. The three-party bootstrap changes the factory-state and bootstrap-offer validators plus the offer redeemer, so legacy DEX factories cannot be upgraded in place. Build the new blueprint, review the deployment record, then deploy a new Preprod factory with:

```sh
npm run dex:preprod -- redeploy
```

This repository is not audited production code. Complete transaction-level Preprod tests and an independent security review before any mainnet or real-value use.
