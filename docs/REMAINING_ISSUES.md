# Remaining issues

Recorded: 2026-09-25. Baseline: `58527a9` on `main`.

This picks up from [DEVELOPER_HANDOFF_REVIEW.md](DEVELOPER_HANDOFF_REVIEW.md)
(findings R01–R11) and the follow-up review and fix work in `a2d0d2e` and
`58527a9`. Items fixed in those commits are summarised at the end for context.

## 1. Deployment work (fixed in source, not live)

The committed contracts differ from what is deployed on Preprod. Until these
steps are done, the hosted app refuses to sign Marketplace and DEX
transactions (it detects the blueprint/manifest mismatch and fails closed).

| # | Item | What to do |
| --- | --- | --- |
| D1 | **Live Preprod Marketplace is still exploitable.** The deployed `p2p_listing_simple`/`quote_pool` allow taking pool inventory for 1 lovelace and paying several direct listings with one payment. | `npm run marketplace:preprod`, then commit the new `marketplace-deployment.preprod.json`. Interim mitigation until then: the batcher can reprice every pool-owned listing above current pool cash. Pausing the pool does **not** help (`AddFunds` works while paused). |
| D2 | DEX bootstrap-offer cancel fix (R04) is not live. | `npm run dex:preprod -- redeploy`, then commit `dex-deployment.preprod.json`. |
| D3 | No automatic migration. Listings, offers, pools and liquidity under the old scripts keep the old rules. | Inventory remaining outputs at the old addresses before retiring them; plan holder-authorised migration (see R01). |
| D4 | Operator price book returns 503 in production (R02). `amplify.yml` now forwards `PRICE_BOOK_BUCKET`/`PRICE_BOOK_KEY`. | Provision/confirm the private S3 bucket, IAM access and Amplify runtime values; verify `GET /api/price-book` returns 200 and a signed publish works. |
| D5 | Indexer config change required (R03 fix). | Add the registry identity `token` to the registry entry in the deployed `WatchedAddresses` value, or the indexer fails at config parse. |

## 2. Decisions needed

| # | Item | Notes |
| --- | --- | --- |
| X1 | **LP value transfer on early exit.** Shares are minted against `cash + inventory_cost`, but `RemoveLiquidity` pays only `lp_burned × (cash − reserve) / supply`. Early leavers forfeit their share of inventory and reserve to remaining LPs. | `quote_pool.ak` LP math. Documented in the contract README, but a real economic effect. Changing it is a validator + deployment change. |
| X2 | **Batcher trust (R05, partly fixed).** The reserve floor is now enforced on-chain. Still trusted: `UpdatePrices` has no bands/spread/buy≤sell rule; the admin can set any `min_cash_reserve`; Team and batcher are the same key in the manifest. | Either enforce more on-chain or document the trusted-operator model, monitoring and incident response. |

## 3. Open engineering work

| # | Item | Notes |
| --- | --- | --- |
| E1 | **R01: legacy deployments are not discoverable.** DEX and Portfolio scan only the current deployment. At the last check an old DEX pool (`67e44c32…933b#1`, 100 tADA + 1,000 FT) was still unspent. The old Marketplace deployment and the upcoming redeploys add more legacy state. | Archive every deployment with its blueprint revision; discover authenticated legacy positions and offer labelled withdraw/close routes with the matching historical scripts. |
| E2 | **R08: no durable pending-transaction state.** Submitted hashes, bootstrap CBOR/witness handoffs and operator receipts live in React state and are lost on reload. | Persist a scoped journal (network, wallet, operation, hash, inputs, status) and reconcile before allowing retry. |
| E3 | **R10: deployment gate is partial.** Amplify now runs the Node unit tests before building. Not gated: Aiken, Playwright, off-chain tests, Preprod suites. | Add a CI workflow (e.g. GitHub Actions) that runs `aiken check --deny` for each contract project, `npm run test:browser`, and `npm --prefix infra/offchain test`. |
| E4 | Minter strict check fails. `contracts/minter/aiken.toml` pins compiler v1.1.19; installed is v1.1.21, so `aiken check --deny` exits 1 on the version warning. | Bump the pin (and rebuild/verify hashes) or install the pinned compiler in CI. |
| E5 | **R11: deployment docs point at another Amplify app.** `docs/AMPLIFY_DEPLOYMENT.md` names `d2r4qj82rav2zq` (us-west-1); `docs/OFFCHAIN_DEPLOYMENT.md` and the live site use `d1g3uigoyq3hsb`. | Confirm the active app/account/region and correct the docs. |
| E6 | Quota abuse is only reduced. The Blockfrost proxy now has an endpoint allowlist and body caps but no rate limit; IPFS upload has size/field caps but no authentication. | Add a WAF/rate-limit rule; consider requiring a wallet signature for uploads. |
| E7 | Legacy request cancellation still needs exact value. Old `pool_sell_request` outputs (source archived, pinned script in `legacy-request-recovery.json`) can only be cancelled if the UTxO value equals its datum. Mismatched outputs are unrecoverable under that script. | Cannot be changed for existing outputs. Optionally scan the legacy request address to confirm none are affected. |

## 4. Minor (P3)

| # | Item |
| --- | --- |
| M1 | Orderbook `Reprice` does not check which redeemer the pool is spent with, so the batcher can let `inventory_value` (reporting only) drift. |
| M2 | `inventory_policy` accepts any negative burn; harmless today because every pool path requires exactly −1. |
| M3 | Async refreshes in `reserves-workbench`, `team-workbench` and `legacy-request-recovery` have no cancellation guard, so a slow read can show a previous wallet's data (signing is protected by the wallet guard). |
| M4 | The dev-mode price-book `.lock` file can stick after a crash (every publish then returns 409); raw storage/JSON errors are returned to the client with status 400. |
| M5 | The operator console gate is client-side only. Acceptable because no secrets sit behind it, but docs must not describe it as a security boundary. |

## 5. Manual verification still needed

- **Eternl account switch mid-flow.** The wallet-session guard is unit-tested but has not been exercised with a real extension switching accounts between build and sign.
- **Real three-wallet bootstrap in the browser.** The Preprod suite drives the same transactions from scripts, not through the UI.

## How to re-verify

```sh
node --experimental-strip-types --test tests/*.test.mjs
npm --prefix infra/offchain test
(cd contracts/marketplace && aiken check --deny)
(cd contracts/dex && aiken check --deny)
npm run build && npm run test:browser

# Preprod acceptance with the demo wallets (isolated deployments; the committed
# manifests are never modified). Progress is journaled under test-results/;
# delete the journal file to start a fresh run.
npm run e2e:marketplace:preprod   # last run: 38 steps, 6/6 attacks rejected
npm run e2e:dex:preprod           # last run: 24 steps, 13/13 attacks rejected
```

The Preprod suites fund the four demo wallets from `CARDANO_WALLET_SEED` (300
tADA each on the first run); the remaining test funds stay in those wallets.

## Fixed in `a2d0d2e` / `58527a9` (for context)

- Pool inventory theft via `AddFunds`, listing piggybacking, and direct-listing
  double satisfaction (Marketplace validators).
- Single-listing enforcement for `BatcherAcquire`, `InventorySale`, `Reprice`,
  `ReturnClosingInventory`; whole-escrow seller cancel.
- Burnable `one_shot` identity, so final LP exit and pool closure complete (R06).
- DEX owner cancel of malformed bootstrap escrows (R04).
- IPFS gateway stored XSS; Blockfrost proxy allowlist; IPFS upload limits.
- Shared pre-build/pre-sign wallet guard (R07); shared chain provider for all
  readers (R09); ADA pool reserve ≥ 2 ADA; Amplify unit-test gate (R10, partial).
- Indexer registry authentication and fail-safe sync status (R03).
- Legacy `pool_sell_request` source archived.
