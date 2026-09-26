# Shared-pool Marketplace operations

This guide implements [the contracts handover](MARKETPLACE_UI_HANDOVER.md). It supersedes the earlier ten-field pool / separate request workflow. The legacy oracle/USDM runbook is not this deployment.

## Deployment gate

The Preprod manifest records a fresh 14-field marketplace deployment. UI signing requires matching orderbook/pool addresses and matching LP/inventory policies derived from the supplied blueprint. Incompatible state is reported as unavailable, never as zero balances. Do not replace addresses without a reviewed deployment and asset migration plan. The previous deployment is preserved in `supersedes`; its listings, pool funds, registry and requests were not consumed or migrated.

Combined pool/listing transactions need reference scripts to fit ledger limits. The manifest's `referenceScripts` array contains exact output references for orderbook, quote pool, LP policy and inventory policy. Readers require all four distinct hashes. References live at the separate `referenceCustody` native-script address, recoverable by the Team signature; ordinary wallet coin selection cannot consume them. Do not recover these outputs while this deployment is in use.

The current `one_shot` identity policy supports burning. The fresh deployment records `pool.identitySeed` (a public UTxO reference, not a wallet secret), allowing the UI to reconstruct the policy and verify its hash before enabling final exit. Compiled-validator emulator tests exercise deposit, final withdrawal and identity burning with this policy. Older identities minted by the non-burning policy, or manifests without a matching seed/policy, remain gated. This is not proof of live Eternl closure or production readiness.

## Deployment and recovery commands

1. Run `npm run marketplace:preprod -- plan-redeploy` for a read-only plan. It builds/evaluates the bootstrap without signing, reports public override mismatches and estimates required test ADA. The current registry already matches the blueprint and is reused. Add `--replace-registry` only when a registry mismatch requires a separately approved replacement.
2. After explicit approval to spend test ADA and leave old positions untouched, run `npm run marketplace:preprod -- redeploy --confirm-fresh-testnet`. If registry replacement was approved, also pass `--replace-registry`: it copies the exact approved list/version and issuer from the authenticated prior output. That output is referenced by the bootstrap so a concurrent registry update invalidates the transaction instead of copying stale state.
3. The ignored `marketplace-deployment.preprod.pending.json` records signed transactions **before** submission. Rerun the same command after a timeout; never delete the journal or manually create a new identity to resolve ambiguous confirmation. A signed reference transaction is rebuilt only when another confirmed journal transaction provably consumed its input; rejected attempts remain in the journal. A leftover `.lock` after a killed process needs inspection before removal; never run concurrent deployers.
4. The public manifest is atomically replaced only after pool, registry, identities and all four references verify on-chain. Run `npm run marketplace:preprod -- status` to recheck it. `fund <lovelace>` uses the same 14-field transaction builder as the UI and refuses incompatible state. Deployment itself supplies only the 20 tADA protected reserve; it does not create liquidity-provider shares or post prices.
5. Rebuild/publish the application. Amplify uses `npm run build:preprod`, which takes all marketplace addresses/registry identities from the committed manifest, overriding stale hosting values as one coherent set. Ordinary local `npm run build` still supports explicit `.env.local` overrides; remove stale values or copy the manifest's public values. Never copy the admin seed or the entire local environment into hosting.

For a later blueprint upgrade, an already-published journal is not a new deployment plan. Verify its transaction confirmations and exact correspondence to the old manifest, then archive it under ignored `.data/deployment-journals/` before starting the approved replacement. Preserve incomplete or ambiguous journals in place; do not archive them to bypass recovery checks.

The current request-enabled registry was reused unchanged. Any future replacement would not discover or migrate requests against previous registries. Old requests and old pool funds require their original validators and a separate recovery plan. Publishing new prices, adding LP liquidity and configuring durable off-chain acquisition limits are subsequent operator actions, not part of deployment.

The Operator Console menu and every `/team/...` route require the connected marketplace batcher, configured Team recovery key or DEX factory administrator. Account changes/disconnection revoke UI access. This is a navigation guard; transaction validators and API signature checks remain the authorization boundary. Public registry requests remain available to ordinary wallets.

### Verified fresh Preprod deployment

Current bootstrap transaction (2026-09-25): `4c73fe171272e18b84eb1ed2b760652cf210c83e92d61adc5cc04cb703aebfdb`. Exact identities and all four confirmed reference outputs are in `marketplace-deployment.preprod.json`; see the [deployment record](PREPROD_REDEPLOYMENT_2026-09-25.md) for DEX and acceptance results.

Post-deployment checks found 20 tADA cash/protected reserve, zero LP supply, no posted prices, and four matching reference scripts. The current registry was reused unchanged (one approved asset). The immediately superseded pool still held 20 tADA; still older deployments remain in `supersedes`. No listings, LP balances or old requests were migrated. Current reference-script deposits total 90.026450 tADA at the Team-controlled native-script address. These are deployment-time observations, not a live balance feed.

The preceding deployment exposed a Blockfrost indexing delay: confirmation preceded updates to wallet/address UTxO listings. Its rejected reference transaction and proven-conflict replacement are preserved in the archived journal. The deployment tooling excludes journaled spent inputs and waits for reference-output indexing; it never treats an ambiguous timeout alone as permission to create another identity.

## Roles and pricing

- Sellers create Direct or InstantSell listings from Portfolio. Both can be edited/cancelled before settlement. InstantSell is a seller-owned marketplace listing, not publicly buyable.
- Buyers purchase Direct or QuotePool inventory listings.
- The batcher posts on-chain prices, acquires InstantSell listings and reprices inventory.
- The administrator changes reserve floor / pause state.
- LPs deposit, withdraw cash, or recover inventory during an already-started closing sequence.

On-chain price entries contain an exact asset plus positive integer buy and sell ratios. For quantity Q, bid and ask are respectively `floor(Q * numerator / denominator)` in quote-asset base units. Zero-rounded results are rejected. At most 50 unique assets may be priced. Removing an entry disables new acquisitions for that asset on-chain; existing inventory remains independently priced.

The separate off-chain controls retain maximum units per request, maximum units held in pool inventory and active status, as requested. They are signed operator messages, not validator guarantees. Existing storage price fields remain for compatibility but are never executable prices in the new flow. Pending listings reserve no capacity.

## Operator workflow

1. Connect the batcher at `/team/inventory`. Review pool identity, quote unit and current state.
2. Stage buy/sell ratios and sign the on-chain price update. Updates are allowed while paused, but not during closing.
3. Publish the separate off-chain limits and active switches. Neither the registry nor an oracle determines executable prices.
4. At `/team`, review pending listings, exact units, minimum payout, current bid/ask, cash and limits. Enter an approval reference.
5. Sign acquisition. The transaction consumes the seller listing and pool, pays the bid plus the old listing deposit to the seller, mints a receipt and creates inventory with stored acquisition cost. The operator funds the new inventory ADA deposit; pool quote cash falls by the bid only.
6. Confirm and archive the downloadable approval receipt. It records the pool/listing references, limits revision, prices and transaction hash; downloading alone does not prove confirmation.
7. Reprice existing inventory at `/team/inventory`. This atomically changes its ask and aggregate pool ask value, preserving acquisition cost.

Prices and the acquisition reserve floor are enforced on-chain. Quantity caps and active switches are additional off-chain controls. The queue remains visible if limit storage fails, but acquisition is disabled until limits and inventory can be verified.

## LP accounting

The 14-field pool tracks cash, protected reserve, LP supply, inventory **cost**, inventory **ask**, inventory **count**, posted prices and optional closing recipient.

- Deposits mint against cash plus acquisition cost, not resale asks; deposits can proceed with open inventory but not while paused/closing.
- Partial withdrawals pay only the burned fraction of cash above the reserve floor. They can proceed with open inventory or while paused. Burning shares gives up their inventory exposure.
- A rounded-zero cash withdrawal requires explicit acknowledgment.
- Permissionless top-ups add quote funds without LP shares; allowed while paused, not closing.
- A final LP exit burns all LP shares, pays available cash and records the exiting LP. Each remaining inventory listing is then returned with its ADA deposit to that LP, decrementing cost/ask/count and burning its receipt. The final transaction burns pool identity and returns remaining assets, including the reserve floor. The current deployment supplies the matching burn-capable identity; older or unverifiable identities remain blocked.

Inventory return requires the exiting LP, not the batcher. Public inventory sales add ask payment and the inventory deposit to the pool and decrement all inventory accounting.

## Recovery and reconciliation

`/portfolio/orders` independently scans historical request escrows using the archived exact validator from revision `aadedf5`. It offers owner cancellation only, even when new deployment checks fail. This does not migrate old pool inventory or discover every historical deployment.

After confirmation verify pool identity, all three inventory counters, supply, seller/LP payments, receipt mint/burn and exact asset units. Rebuild if any referenced state changes. Session pending hashes have manual confirmation controls but are not a durable cross-page transaction journal.

Off-chain limits require private durable production storage: server-only `PRICE_BOOK_BUCKET`, `PRICE_BOOK_KEY` (default `preprod/instant-sell.json`) and `AWS_REGION`, narrowly scoped S3 GetObject/PutObject permissions and versioning. Revision-checked writes prevent lost updates. Development fallback uses ignored `.data/instant-sell-preprod.json`; production without S3 fails closed. No cloud resources are provisioned here.

Run `npm run test:marketplace` for compiled-validator emulator checks. Real wallet-signed Preprod acceptance and independent review remain necessary before operational use.

Projection indexer deployment is deferred by the owner. The prepared watched-address JSON is not an active AWS update. This deferral does not remove the separate production S3 requirement for operator limits; see [off-chain deployment status](OFFCHAIN_DEPLOYMENT.md).
