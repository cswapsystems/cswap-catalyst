# Amplify Hosting deployment

## Current Preprod environment

- AWS account: `515048575435`
- Region: `us-west-1`
- AWS CLI profile: `catalyst`
- Amplify app: `cswap-catalyst` (`d2r4qj82rav2zq`)
- Platform: `WEB_COMPUTE` (Next.js SSR)
- Default domain: `d2r4qj82rav2zq.amplifyapp.com`
- Source branch: `main` (connect after authorizing the regional AWS Amplify GitHub App)

The app is pinned to Next.js 15 because that is the newest major version listed as supported by Amplify Hosting compute. `next.config.ts` enables asynchronous WebAssembly for Lucid, and `amplify.yml` builds the `.next` SSR artifact.

## Required Amplify variables

Configure these at app scope:

- `NEXT_PUBLIC_CARDANO_NETWORK=preprod`
- `BLOCKFROST_PROJECT_ID` (server-only)
- `BLOCKFROST_IPFS_PROJECT_ID` (server-only)

The buildspec copies only these named values into `.env.production`, as required for Amplify SSR runtime access. Never upload `CARDANO_WALLET_SEED`; the hosted application uses browser wallet signing and the seed remains local to operator scripts.

## Deployment flow

1. Install/authorize the regional AWS Amplify GitHub App for only `cswapsystems/cswap-catalyst`.
2. Connect `https://github.com/cswapsystems/cswap-catalyst` and branch `main` to app `d2r4qj82rav2zq`.
3. Add the two server-only Blockfrost variables.
4. Start a release build and check both static pages and `/api/blockfrost/health`-equivalent API behavior.

Amplify automatically rebuilds `main` after the repository is connected. Runtime logs use the least-privilege `cswap-amplify-ssr-logs` role, constrained to this AWS account and Amplify app.

## Account security

Do not use root credentials for routine deployments. Replace the current root-backed CLI session with an IAM Identity Center or assumed deployment role before ongoing administration, enable root MFA, and remove root access keys if they exist.
