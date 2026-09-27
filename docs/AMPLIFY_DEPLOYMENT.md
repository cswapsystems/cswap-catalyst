# Amplify Hosting deployment

## Current target and verification boundary

The owner-confirmed Preprod URL is `https://preprod.d1g3uigoyq3hsb.amplifyapp.com`. The owner also confirmed a different AWS account is now in use. The active account, CLI profile, region, branch mapping, automatic-build settings and runtime IAM role have not been verified in that account.

Older instructions naming account `515048575435`, profile `catalyst` or app `d2r4qj82rav2zq` are historical, not deployment targets. Confirm the actual Amplify app and connected branch before administering hosting. Use an assumed deployment role or IAM Identity Center, not root credentials.

The repository pins Next.js 15.5.25. `next.config.ts` enables asynchronous WebAssembly for Lucid, and `amplify.yml` builds the `.next` SSR artifact. Confirm the target app is configured for Next.js SSR; do not infer its live settings from this repository.

## Runtime configuration

For Preprod, configure `NEXT_PUBLIC_CARDANO_NETWORK=preprod` and the appropriate server-side `BLOCKFROST_PROJECT_ID` / `BLOCKFROST_IPFS_PROJECT_ID` values.

Marketplace Instant Sell prices are stored in the on-chain shared pool. The separate S3 operator price book has been removed; no `PRICE_BOOK_BUCKET` or `PRICE_BOOK_KEY` is needed.

The buildspec copies only `BLOCKFROST_PROJECT_ID`, `BLOCKFROST_IPFS_PROJECT_ID`, `NEXT_PUBLIC_CARDANO_NETWORK` and `NEXT_PUBLIC_OFFCHAIN_API_URL` into `.env.production` for SSR. Never upload `CARDANO_WALLET_SEED`, signing keys or deployment journals. Browser wallets sign application transactions; deployment credentials stay local.

Indexer deployment is explicitly deferred. Do not configure or replace `NEXT_PUBLIC_OFFCHAIN_API_URL` using historical API URLs; follow [the deferred indexer runbook](OFFCHAIN_DEPLOYMENT.md) when that work resumes.

## Publication and test gate

1. Confirm the intended app, Git branch and commit. A push triggers a build only if that branch is connected with automatic builds enabled.
2. Run `node --experimental-strip-types --test tests/*.test.mjs` and `npm run build:preprod` locally. Amplify runs this Node unit suite before the build; a failing test stops publication.
3. Run Aiken checks, off-chain tests and Playwright separately as appropriate. Those suites are not part of the current Amplify gate; browser engines and Aiken must be provisioned separately.
4. Review the committed Marketplace/DEX manifests. `build:preprod` binds Marketplace configuration to the committed deployment; server APIs load the deployment artifacts. Stale hosting values must not be used to bypass script/schema compatibility checks.
5. After the authorized push, verify the Amplify job's commit and success, then check the hosted deployment status, reads and wallet guards. A successful local build or on-chain transaction is not proof the website was published.

The [2026-09-25 deployment record](PREPROD_REDEPLOYMENT_2026-09-25.md) identifies the confirmed new contracts. Old outputs were not migrated. Contract deployment and website publication are distinct operations.

## Mainnet remains gated

The application includes Preprod-only identities and wallet guards. Mainnet requires reviewed mainnet contracts, manifests, credentials, network handling and acceptance testing. Changing only `NEXT_PUBLIC_CARDANO_NETWORK` is insufficient; do not enable automatic mainnet publication on that basis.
