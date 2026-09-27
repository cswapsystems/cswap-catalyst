# Hardened Marketplace and DEX redeployment

The active validator artifacts match the security fixes in `a2d0d2e`. Marketplace and DEX were freshly deployed using the configured Team wallet. No old script output was consumed by either deployment; old offers, listings, LP balances and pools were not migrated or made safe by creating the new deployments. Do not send new funds to superseded addresses.

## Confirmed deployments

- Marketplace bootstrap: `4c73fe171272e18b84eb1ed2b760652cf210c83e92d61adc5cc04cb703aebfdb`.
- DEX factory bootstrap: `fb56ba304c6cd646517f0b87da25d5f67158ec18adbcd0aaaceb58d21ae03e49`.
- Exact identities, addresses and superseded manifests: `marketplace-deployment.preprod.json` and `dex-deployment.preprod.json`.
- The existing registry was reused unchanged: token `872c22cf727de60c032888cf4d2db617d5b9ded73763659a9f2fff3143535741505f5245474953545259`.
- Marketplace starts with a 20 tADA protected reserve, zero LP supply and no posted prices. Four reference scripts are held at the separate Team-controlled native-script address; their deposits total 90.026450 tADA.
- The new Marketplace identity records its minting seed and matches the updated burn-capable `one_shot` policy. The prior deployment's final-exit identity limitation does not apply to this deployment. Emulator tests include withdrawal and final identity burning; no live LP position was created or closed during redeployment.
- DEX started with a fresh factory and no pools/offers. On 2026-09-26, two persistent [test liquidity pools](PREPROD_TEST_POOLS_2026-09-26.md) were added to that factory. Three-party bootstrap setup remains an operator/user workflow.

The completed earlier Marketplace journal was preserved under ignored `.data/deployment-journals/`; the current journal remains ignored. Wallet seed phrases, private keys and signed transaction journals are not deployment artifacts for Git or hosting. The manifest's public minting seed is only a transaction output reference, not a wallet seed phrase.

## Indexer configuration — deployment deferred

The owner explicitly deferred indexer deployment on 2026-09-25. No AWS/indexer changes were applied; the configuration below is prepared for a future, separately approved rollout.

`infra/offchain/watched-addresses.preprod.json` contains all six active watched addresses and the required registry `token`. To print manifest-derived JSON for review (without applying or writing configuration), run:

```sh
node scripts/indexer-config-preprod.mjs
node --test tests/indexer-deployment.test.mjs
```

When deployment is explicitly resumed, use this JSON as the confirmed stack's `WatchedAddresses` parameter. Preserve its Blockfrost secret reference, network, origin and other parameters. Follow [the off-chain runbook](OFFCHAIN_DEPLOYMENT.md), then verify `/v1/status` and `/v1/registry/assets`: the registry must report `synced` with the expected token/address and approved assets. Review old-address projection rows separately; changing watched addresses is not a migration or cleanup of existing cached rows.

**The owner confirmed a different AWS account is in use.** The historical account/stack instructions are not current deployment targets. Neither local AWS profile (`default`, `cswap`) found the historical stack in `us-west-1`; no indexer API URL was configured locally or found in the hosted page's initial bundles. This does not prove no indexer exists. Confirm the active account/profile, region and stack/API URL when resuming; do not guess or create a replacement stack.

On-chain confirmation is separate from website publication. The public Preprod URL is `https://preprod.d1g3uigoyq3hsb.amplifyapp.com`; confirm the connected branch, deployed commit and successful Amplify job before claiming it serves these manifests. The S3 operator-limit service was subsequently removed; current Instant Sell quotes read the on-chain pool.

## Acceptance boundaries

Passed before submission: 50 Marketplace Aiken tests, 24 DEX Aiken tests, 88 application tests and 23 off-chain tests. An additional regression test checks that the committed watched-address configuration follows both deployment manifests and includes the registry token.

Post-deployment verification passed all 89 application tests, all 14 browser tests and the Preprod production build. Read-only chain checks authenticated the new factory and pool, matched every reference/policy, confirmed the old pool and factory were unchanged, and authenticated the registry through the indexer code. DEX UI derivation confirms factory creation and bootstrap-offer compatibility.

Real Eternl account switching during wallet approval still needs a manual test: stage an action with the expected account, switch accounts before approving, and verify the app rejects/requires reconnection rather than completing under the wrong wallet. Automated wallet guards and mock-wallet browser tests do not replace that extension-level test. The multi-wallet Preprod acceptance scripts create additional test transactions and were not run as part of this deployment-only operation.
