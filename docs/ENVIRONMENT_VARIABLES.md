# Environment variables

This is the canonical environment-variable reference for CSWAP Catalyst. Start
local development by copying `.env.example` to `.env.local` and set only the
values needed for the workflows you use. `.env.local` is ignored by Git.

Variables beginning with `NEXT_PUBLIC_` are embedded in browser JavaScript at
build time. They must contain public identifiers only. Never store recovery
phrases, signing keys, payment keys, API credentials, or other secrets in them.

## Application configuration

| Variable | Required | Visibility | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_CARDANO_NETWORK` | Yes | Browser | Cardano network used by the UI and server routes. Use `preprod` for the current deployment. Mainnet is not enabled merely by changing this value. |
| `BLOCKFROST_PROJECT_ID` | For chain access | Server only | Blockfrost Cardano project ID used by the proxy routes and Preprod deployment/acceptance scripts. Use a project for the configured Cardano network. |
| `BLOCKFROST_IPFS_PROJECT_ID` | For mint uploads | Server only | Separate Blockfrost IPFS credential used by the IPFS upload route. It is not interchangeable with `BLOCKFROST_PROJECT_ID`. |
| `NEXT_PUBLIC_TEAM_KEY_HASH` | No | Browser | Team payment-key hash used by recovery and shared-pool controls. The committed Preprod marketplace manifest supplies the default. |
| `NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS` | No | Browser | Local orderbook-address override. The committed Preprod marketplace manifest supplies the normal value, and `build:preprod` enforces it. |
| `NEXT_PUBLIC_QUOTE_POOL_ADDRESS` | No | Browser | Local shared quote-pool address override. The committed Preprod marketplace manifest supplies the normal value, and `build:preprod` enforces it. |
| `NEXT_PUBLIC_ASSET_REGISTRY_TOKEN` | No | Browser | Local registry identity-token override. The committed Preprod marketplace manifest supplies the normal value, and `build:preprod` enforces it. |
| `NEXT_PUBLIC_ASSET_REGISTRY_ISSUER` | No | Browser | Local registry issuer payment-key-hash override. The committed Preprod marketplace manifest supplies the normal value, and `build:preprod` enforces it. |
| `NEXT_PUBLIC_USDCX_UNIT` | No | Browser | Default policy ID plus asset-name hex shown for the USDCx side of a DEX bootstrap offer. Users can enter the unit in the form when this is unset. |

For ordinary local development, a minimal `.env.local` is:

```dotenv
NEXT_PUBLIC_CARDANO_NETWORK=preprod
BLOCKFROST_PROJECT_ID=
BLOCKFROST_IPFS_PROJECT_ID=
```

Blank optional overrides can be omitted. Restart the development server after
changing a `NEXT_PUBLIC_` value. Production builds must also be rebuilt because
these values are inlined during `next build`.

## Deployment and acceptance scripts

| Variable | Required | Purpose |
| --- | --- | --- |
| `CARDANO_WALLET_SEED` | Only for on-chain deployment and Preprod acceptance scripts | Recovery phrase for the local test Team wallet used to sign transactions. Keep it only in ignored local configuration; never configure it in Amplify or expose it to the browser. |

`npm run dex:preprod`, `npm run marketplace:preprod`, and the on-chain Preprod
acceptance scripts also require `BLOCKFROST_PROJECT_ID`. These commands can
spend test funds and are separate from building or hosting the application.

## Build and test tooling

| Variable | Required | Purpose |
| --- | --- | --- |
| `CSWAP_NEXT_DIST_DIR` | No | Overrides Next.js's output directory. Use the same value for build and start, such as `.next-review`, when verifying alongside an active development server. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | No | Uses a specific Chromium/Chrome executable for Playwright browser tests. |

PowerShell examples:

```powershell
$env:CSWAP_NEXT_DIST_DIR='.next-review'
npm run build
npm run start

$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE='C:\Path\To\chrome.exe'
npm run test:browser
```

## Amplify Hosting

Configure these values in the confirmed Amplify application for the hosted
Preprod build:

- `NEXT_PUBLIC_CARDANO_NETWORK=preprod`
- `BLOCKFROST_PROJECT_ID`
- `BLOCKFROST_IPFS_PROJECT_ID` when hosted mint uploads are enabled
- `NEXT_PUBLIC_USDCX_UNIT` only when a default USDCx unit is desired

The build uses the committed Marketplace deployment manifest for the orderbook,
quote pool, registry token, and registry issuer. Do not add stale per-address
Amplify overrides. Never upload `CARDANO_WALLET_SEED` to Amplify.

## Deferred off-chain stack

The optional projection/indexer stack under `infra/offchain` is currently
deferred. CloudFormation manages its Lambda environment, including
`TABLE_NAME`, `CARDANO_NETWORK`, `WATCHED_ADDRESSES`, and
`BLOCKFROST_SECRET_ARN`; these do not belong in the application's `.env.local`.
The Blockfrost secret is stored in AWS Secrets Manager as JSON containing a
`projectId` field.

The frontend does not currently consume an off-chain API URL. If the deferred
stack is resumed, add the integration to the application before introducing a
new public URL variable.

## Removed variables

Do not restore these legacy settings:

- `NEXT_PUBLIC_OFFCHAIN_API_URL`: no application code consumes the deferred API.
- `AWS_REGION`: belonged to the removed S3 price-book flow.
- `NEXT_PUBLIC_VAULT_ADDRESS`: belonged to the retired wallet directory; the
  active vault page derives its contract configuration from the deployment.
- `NEXT_PUBLIC_ISSUER_WALLET`, `NEXT_PUBLIC_CUSTODY_WALLET`,
  `NEXT_PUBLIC_TREASURY_WALLET`, and `NEXT_PUBLIC_SETTLEMENT_WALLET`: belonged
  to the retired four-wallet directory. Current operations use the connected
  authorized wallet and committed deployment identities.

For workflow details, see [wallet configuration](../WALLET_CONFIGURATION.md),
[asset registry operations](ASSET_REGISTRY.md),
[Amplify deployment](AMPLIFY_DEPLOYMENT.md), and
[off-chain deployment status](OFFCHAIN_DEPLOYMENT.md).
