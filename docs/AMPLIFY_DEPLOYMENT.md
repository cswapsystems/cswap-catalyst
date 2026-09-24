# Amplify Hosting deployment

## Amplify environments

- AWS account: `515048575435`
- Region: `us-west-1`
- AWS CLI profile: `catalyst`
- Amplify app: `cswap-catalyst` (`d2r4qj82rav2zq`)
- Platform: `WEB_COMPUTE` (Next.js SSR)
- Default domain: `d2r4qj82rav2zq.amplifyapp.com`
- Preprod source branch: `preprod` (`BETA`, automatic builds enabled)
- Mainnet source branch: `mainnet` (`PRODUCTION`, automatic builds disabled until Mainnet contracts are deployed)

The app is pinned to Next.js 15 because that is the newest major version listed as supported by Amplify Hosting compute. `next.config.ts` enables asynchronous WebAssembly for Lucid, and `amplify.yml` builds the `.next` SSR artifact.

## Required Amplify variables

Configure these as branch overrides:

- `preprod`: `NEXT_PUBLIC_CARDANO_NETWORK=preprod` and the Preprod `BLOCKFROST_PROJECT_ID` / `BLOCKFROST_IPFS_PROJECT_ID` values.
- `mainnet`: `NEXT_PUBLIC_CARDANO_NETWORK=mainnet`; its Blockfrost values remain deliberately unconfigured until Mainnet credentials are supplied.

Operator price-book storage also needs `PRICE_BOOK_BUCKET` (and optionally `PRICE_BOOK_KEY`, default `preprod/instant-sell.json`); `AWS_REGION` is supplied by the Amplify runtime.

The buildspec copies only `BLOCKFROST_PROJECT_ID`, `BLOCKFROST_IPFS_PROJECT_ID`, `NEXT_PUBLIC_CARDANO_NETWORK`, `NEXT_PUBLIC_OFFCHAIN_API_URL`, `PRICE_BOOK_BUCKET` and `PRICE_BOOK_KEY` into `.env.production`, as required for Amplify SSR runtime access. Never upload `CARDANO_WALLET_SEED`; the hosted application uses browser wallet signing and the seed remains local to operator scripts.

## Deployment flow

1. Install/authorize the regional AWS Amplify GitHub App for only `cswapsystems/cswap-catalyst`.
2. Connect `https://github.com/cswapsystems/cswap-catalyst` to app `d2r4qj82rav2zq`, mapping the existing `preprod` and `mainnet` Amplify environments to their matching Git branches.
3. Build and validate `preprod` first.

**Test gate.** Before `npm run build:preprod`, the buildspec runs the Node unit suite (`node --experimental-strip-types --test tests/*.test.mjs`). Any failing test fails the Amplify build, so nothing is published. Playwright browser tests, `npm run test:offchain` and Aiken contract checks are not installed in the Amplify image; run them locally or in separate CI before merging. Run the same command locally before pushing to a branch that deploys automatically.
4. Deploy contracts and registries on Cardano Mainnet, add Mainnet-specific deployment manifests and Blockfrost credentials, validate wallet/network switching, and only then enable automatic builds for `mainnet`.

Runtime logs use the least-privilege `cswap-amplify-ssr-logs` role, constrained to this AWS account and Amplify app.

The current application contains several deliberately Preprod-only contract addresses and wallet guards. The `mainnet` environment must remain gated until those references are parameterized and fresh Mainnet contract identities are deployed; changing only the network environment variable is not sufficient.

## Account security

Do not use root credentials for routine deployments. Replace the current root-backed CLI session with an IAM Identity Center or assumed deployment role before ongoing administration, enable root MFA, and remove root access keys if they exist.
