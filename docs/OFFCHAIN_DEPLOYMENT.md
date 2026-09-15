# Off-chain AWS deployment

The CSWAP projection API is deployed in AWS account `515048575435`, region `us-west-1`, using the `catalyst` CLI profile.

| Environment | CloudFormation stack | API URL | Indexer |
| --- | --- | --- | --- |
| Preprod | `cswap-offchain-preprod` | `https://e3llm6ycq7.execute-api.us-west-1.amazonaws.com` | Disabled until its Blockfrost secret is configured |
| Mainnet | `cswap-offchain-mainnet` | `https://uzluj5uvw2.execute-api.us-west-1.amazonaws.com` | Gated; disabled until mainnet contracts and credentials are ready |

Both health endpoints were verified after deployment. The API URLs are configured on the matching branches of Amplify app `d1g3uigoyq3hsb` as `NEXT_PUBLIC_OFFCHAIN_API_URL`.

## Resources per environment

- API Gateway HTTP API with CORS, access logging, and route throttling
- read-only API Lambda
- scheduled Cardano projection Lambda (schedule conditionally enabled)
- shared Lambda Layer for pinned AWS SDK dependencies
- encrypted DynamoDB table using on-demand capacity and point-in-time recovery
- DynamoDB lease lock preventing overlapping indexer runs
- Lambda error alarms and X-Ray tracing
- Secrets Manager reference with least-privilege Lambda access

Mainnet's DynamoDB table also has deletion protection enabled. Both tables and API access-log groups use retain policies. The private, versioned deployment bucket is `cswap-catalyst-artifacts-515048575435-us-west-1`.

## Enabling an indexer

The corresponding Secrets Manager value must first be set to JSON containing the correct network-specific project ID:

```json
{"projectId":"..."}
```

Then redeploy the same stack with `EnableIndexer=true`. Do not enable mainnet using preprod addresses or credentials. The Cardano wallet seed is not used by this stack and must never be placed in Lambda configuration.
