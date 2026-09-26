# CSWAP off-chain projection API

**Deployment deferred by the owner (2026-09-25).** The active AWS account differs from the historical runbook and its stack/region are unconfirmed. This document is a future deployment reference, not authorization to apply cloud changes. See [current status and rollout prerequisites](../../docs/OFFCHAIN_DEPLOYMENT.md).

This stack deploys one isolated environment (`preprod` or `mainnet`) containing:

- an encrypted, on-demand DynamoDB projection table with point-in-time recovery;
- a scheduled Lambda indexer that reconciles the canonical UTxO set at configured script addresses;
- a shared Lambda Layer containing pinned AWS SDK v3 dependencies;
- a read-only Lambda API behind API Gateway HTTP API;
- API access logs, X-Ray tracing, throttling, and error alarms.

The database is a cache/projection, never the authority for ownership, prices, registry membership, or pool balances. Those remain on-chain. The indexer stores slot and block hash checkpoints and performs a full watched-address reconciliation on every run, so a Blockfrost view changed by a Cardano rollback replaces stale UTxOs instead of preserving them.

## API

- `GET /health`
- `GET /v1/status`
- `GET /v1/registry/assets`
- `GET /v1/registry/assets/{unit}`
- `GET /v1/state/{kind}` where kind is `registry`, `orderbook`, `quote-pool`, `vault`, `dex-factory`, or `dex-pool`

List routes accept `limit` (1-100) and an opaque `cursor`.

## Secret contract

The complete prepared Preprod configuration is [watched-addresses.preprod.json](watched-addresses.preprod.json). From the repository root, `node scripts/indexer-config-preprod.mjs` prints manifest-derived JSON without writing or applying it; `node --test tests/indexer-deployment.test.mjs` validates the committed file. The single-entry example below is not the complete six-address configuration.

`WatchedAddresses` is a JSON array of `{"kind","address"}` objects. The single `registry` entry must also carry `token`, the registry identity NFT unit (policy ID + asset name hex), copied with `address` from the deployment manifest's `registry` section, e.g. for Preprod:

```json
[{"kind":"registry","address":"addr_test1wpvmzq5wvwyz4xt2pht725d47sngwjll7ajegx3rpy5y75gvpdr46","token":"872c22cf727de60c032888cf4d2db617d5b9ded73763659a9f2fff3143535741505f5245474953545259"}]
```

The indexer trusts only the one output at that address holding exactly one identity token, and schema-validates its inline datum. If authentication or decoding fails, the last authenticated supported-asset set is kept and `registry.state` in `GET /v1/registry/assets` reports `failed` (with `error` and `lastSyncedAt`); `synced` means the served set (possibly empty) is authenticated, and `unavailable` means no sync has completed.

`BlockfrostSecretArn` must identify an AWS Secrets Manager secret whose JSON value is:

```json
{"projectId":"preprod..."}
```

Never pass a wallet seed, signing key, or Blockfrost project ID as a public frontend variable. The Lambda execution role can read only the named secret. Mainnet should be deployed with `EnableIndexer=false` until mainnet addresses and a mainnet Blockfrost project are explicitly configured.

## Future build and deployment reference — deferred

Only after explicit approval and confirmation of the existing target, install the shared layer dependencies, then package from this directory. Replace placeholders with reviewed values; preserve existing stack parameters. Keep scheduling disabled until separately approved:

```powershell
npm.cmd run package:layer
npm.cmd test
aws cloudformation package --template-file template.yaml --s3-bucket <artifact-bucket> --output-template-file packaged.yaml --profile <deployment-profile> --region <deployment-region>
aws cloudformation deploy --template-file packaged.yaml --stack-name <confirmed-preprod-stack> --capabilities CAPABILITY_IAM --parameter-overrides EnvironmentName=preprod CardanoNetwork=preprod AllowedOrigin=https://preprod.d1g3uigoyq3hsb.amplifyapp.com WatchedAddresses='<complete-reviewed-json>' BlockfrostSecretArn=<secret-arn> EnableIndexer=false --profile <deployment-profile> --region <deployment-region>
```

The deployment table is retained if the CloudFormation stack is deleted. Mainnet additionally enables DynamoDB deletion protection.
