# Off-chain AWS deployment

## Current status — deferred

The owner deferred indexer deployment on 2026-09-25. No indexer cloud changes were applied during the [Marketplace/DEX redeployment](PREPROD_REDEPLOYMENT_2026-09-25.md). Do not deploy, enable a schedule, create a replacement stack or change the hosted API URL until this work is explicitly resumed.

The owner confirmed a different AWS account is now used. Historical references to account `515048575435`, profile `catalyst`, region `us-west-1` and stack `cswap-offchain-preprod` are not verified active targets. The current account/profile, region, stack and API URL remain to be confirmed. The public website is `https://preprod.d1g3uigoyq3hsb.amplifyapp.com`; its URL alone does not establish the indexer's account or region.

## Configuration ready for review

[`watched-addresses.preprod.json`](../infra/offchain/watched-addresses.preprod.json) contains the registry, orderbook, quote pool, vault, DEX factory and DEX pool addresses derived from the committed deployments. The registry entry includes its identity NFT `token`; omitting it prevents the current indexer from starting.

From the repository root, these commands print candidate JSON and validate the committed configuration without deploying anything:

```sh
node scripts/indexer-config-preprod.mjs
node --test tests/indexer-deployment.test.mjs
npm --prefix infra/offchain test
```

The registry reader authenticates the singleton NFT and datum. Authentication failures retain the last authenticated asset set and report `failed`; they must not be shown as a successful empty registry.

## Future rollout checklist

After explicit approval to resume:

1. Confirm the AWS identity, region, existing stack, artifact bucket, API URL and allowed website origin. Inspect existing parameters before proposing changes.
2. Preserve the network-specific Blockfrost secret reference and other reviewed parameters. The secret is JSON containing `projectId`; no wallet seed is used by this stack.
3. Review the complete watched-address file against both manifests. Decide how superseded-address cache rows will be handled: changing addresses does not migrate or clear those rows automatically.
4. Package/test the current code using [the infrastructure guide](../infra/offchain/README.md). Keep the indexer disabled until its credentials, addresses and rollout are approved.
5. After the approved update, check `/health`, `/v1/status` and `/v1/registry/assets`. Require an authenticated, synced registry with the expected identity and assets; inspect logs and scheduled reconciliation.
6. After validating the API, implement and review the frontend integration
   before introducing any hosted URL variable. Verify the hosted app
   independently.

## Infrastructure and separate dependencies

The template defines an HTTP API, read-only API Lambda, scheduled projection Lambda, dependency layer, encrypted DynamoDB projection table, lease lock, logs, alarms and least-privilege secret access. This describes repository infrastructure, not a verified inventory of the new AWS account. Retain policies protect the table and API log group; mainnet additionally enables table deletion protection.

The projection database is a cache, not an authority for ownership or transaction signing. Mainnet remains gated pending mainnet contracts and credentials. Marketplace Instant Sell prices come from the on-chain pool; the old S3 operator-limit service is removed.
