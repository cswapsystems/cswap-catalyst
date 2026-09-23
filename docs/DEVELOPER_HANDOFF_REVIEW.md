# Developer handoff: code review and gap analysis

Reviewed: 2026-09-23 UTC. Baseline: `026a13dd91bf2ec2198a3c3eb2b4c4f10befec02`.
Working branch: `main`; `main` and `preprod` pointed to this same commit at review time.

This is a review, not a security certification or a declaration of production readiness. No application fixes, cloud changes, or public-chain transactions were performed in this review. Findings below distinguish live observations, isolated reproductions, source-level findings, and remaining acceptance work. Line references refer to the baseline commit.

## Start here

The build passes, but the product is not operationally complete. Prioritize recovery visibility for an existing legacy pool, restore durable operator pricing, authenticate the indexed registry, and address malformed bootstrap escrow recovery before expanding usage. Resolve the shared-pool trust model before representing its reserve floor as an on-chain guarantee.

| ID | Priority | Finding | Evidence | Suggested owner |
| --- | --- | --- | --- | --- |
| R01 | P1 | Redeployment hides a legacy pool that still holds funds | Public-chain read + source | DEX/full-stack |
| R02 | P1 | Deployed price-book service returns 503 | Live HTTP + configuration review | AWS/full-stack |
| R03 | P1 | Indexer accepts an unauthenticated registry datum | Isolated reproduction | Off-chain/indexer |
| R04 | P1 | Owner cannot cancel an otherwise decodable escrow with mismatched value | Emulator reproduction | Aiken/DEX |
| R05 | P1 decision | Acquisition reserve floor and registry admission are UI checks, not validator guarantees | Source; previously documented limitation | Protocol/Aiken/product |
| R06 | P2 | Shared-pool close branch conflicts with its deployed identity policy | Source | Aiken/marketplace |
| R07 | P2 | DEX lacks a consistent pre-sign account-change guard | Source; extension-dependent risk | Wallet/UI |
| R08 | P2 | Pending transactions, bootstrap handoffs, and receipts are not durable | Source; known limitation | Full-stack |
| R09 | P2 | Protocol-parameter error protection is not used by all readers | Source | Wallet/data layer |
| R10 | P2 | Tests are not deployment gates; strict minter check currently exits 1 | Fresh checks + buildspec | CI/contracts |
| R11 | P2 | Deployment runbook identifies a different Amplify app | Public URL + docs | AWS/docs |

P1 means address before broader use or explicitly resolve the stated trust decision. P2 means schedule a concrete corrective task; it does not mean the risk is harmless. No public exploit attempts were made.

## Current deployment observations

Target supplied by the product owner: `https://preprod.d1g3uigoyq3hsb.amplifyapp.com/my-assets`.
Read-only checks at approximately **2026-09-23 01:30 UTC**:

| Check | Observed result |
| --- | --- |
| `GET /api/blockfrost/epochs/latest/parameters` | 200; protocol parameters returned |
| `GET /api/dex-blueprint` | 200; latest factory transaction matches the local manifest |
| `GET /api/price-book` | 503; durable storage configuration/access error |
| Latest and immediately superseded AMM address UTxO requests | 404; no pool UTxOs returned by these requests |
| Older AMM recorded under `supersedes.supersedes` | 200; one unspent pool output, detailed in R01 |

Latest factory transaction: `02286df2d4da548a90ed9c78a94e7055b0fe59c1e474e1a164dbe0310b6a14f6`.

The earlier wallet incident involved a Blockfrost configuration error. That endpoint is now responding successfully; **do not carry forward the old assertion that the deployed Blockfrost key is still missing**. This HTTP observation does not establish real-wallet interoperability or validate every provider endpoint. A successful blueprint response also does not prove the hosted JavaScript matches this exact Git commit; add a deployment version indicator.

## Findings and acceptance criteria

### R01 — P1: existing legacy liquidity is absent from current discovery

**References:** `src/lib/protocol/dex-client.ts:70`, `src/app/_components/dex-workbench.tsx:36`, `src/lib/portfolio.ts:60`, `src/lib/portfolio.ts:70`, `dex-deployment.preprod.json`.

The loader exposes only the top-level deployment. DEX scans only its `ammAddress`; Portfolio similarly limits DEX LP positions and bootstrap commitments to the configured deployment. Nested `supersedes` history is not used for discovery or recovery.

The following older pool was still unspent during this review:

- Address: `addr_test1wpf8ca3uef8sxg0jnv2deec7u4r0vzvukyrq9kznzrelk7gewvksx`.
- Output: `67e44c32d482ba78db7fe2cdab0e792c6195ce438e02f77b371d96493291933b#1`.
- Value: **100,000,000 lovelace (100 tADA), 1,000 fraction-token base units, and one pool NFT**.
- Deployment factory transaction: `4c87343fb1ec90a3109d12f5e8f0d3aac9b453635c094a22b6779c6101bb11fa`.

This is an actual visibility/recovery gap, not evidence the funds were stolen or that the pool is unspendable. LP ownership, recoverable withdrawal amounts, and compatibility of the historical scripts were not established by this read.

**Next work:** archive each deployment with its exact blueprint/source revision, identity tokens, parameters and lifecycle status. Discover authenticated legacy positions, expose an explicitly labeled legacy withdrawal/closure route, and document a holder-authorized migration procedure. Do not derive every historical script from today's blueprint or replace the manifest as a substitute for migration.

**Acceptance:** enumerate all recorded deployments; show this live legacy position for a wallet holding its LP token; authenticate each pool; demonstrate withdrawal/closure with the matching scripts and required authority in an emulator, then obtain approval for a Preprod transaction. Do not mark a deployment retired until its remaining outputs have been inventoried and disposition recorded.

### R02 — P1: production price storage is unavailable

**References:** `src/app/api/price-book/route.ts:10`, `src/lib/server/price-book-store.ts:7`, `src/app/_components/team-workbench.tsx:46`, `amplify.yml:11`.

The live GET returns:

> Price storage unavailable. Configure PRICE_BOOK_BUCKET, AWS_REGION and server IAM access in production.

The Team queue loads the book inside `Promise.all`, so this failure also interrupts its refresh. Production intentionally fails closed without durable storage. The buildspec forwards the Blockfrost/network/off-chain API variables but does not forward `PRICE_BOOK_BUCKET` or `PRICE_BOOK_KEY`; its runtime-variable mechanism must be completed. The endpoint's generic error cannot distinguish missing configuration, region, IAM, malformed stored data, or an S3 failure. Actual cloud runtime settings were not accessible in this review; the exact deployed cause remains unconfirmed.

**Next work:** identify the active Amplify app/account/region, provision or identify the private S3 object store, configure runtime values and least-privilege access, and add sanitized server diagnostics. Preserve conditional writes and production fail-closed behavior. Never copy operator seeds or a whole local environment file into hosted artifacts.

**Acceptance:** production GET returns 200; an authorized operator can sign and publish a price revision; unauthorized/expired signatures fail; concurrent stale updates return 409; the published revision survives a new SSR instance and redeployment. Verify bucket versioning/history and recovery procedures. Add a deployment health gate for this service.

### R03 — P1: registry cache can be populated from a non-registry output

**References:** `infra/offchain/runtime/indexer.mjs:20`, `infra/offchain/runtime/indexer.mjs:37`, `infra/offchain/runtime/config.mjs:3`, `infra/offchain/runtime/api.mjs:30`.

`supportedAssetsFrom` takes the first output with an inline datum at the watched address. It does not require the registry identity NFT. Watch configuration retains only `kind` and `address`, so it cannot express the necessary identity check. The resulting assets replace the supported-assets cache and are served by the registry API.

**Reproduced locally:** invoke the exported `createIndexer` with an in-memory store and one registry-address UTxO containing only lovelace plus a syntactically valid registry datum, version `999`, listing an arbitrary token. It writes that token as `entity: "supported-asset"`, despite there being no identity NFT. A malicious output selected before the authentic output can therefore misrepresent admission; malformed selected data can also interrupt synchronization. No such output was posted to Preprod, and this review did not verify a live indexer deployment.

The browser's direct `readRegistry` path correctly checks the configured token, address and quantity (`src/lib/asset-registry.ts:126`). This finding concerns the off-chain cache/API, not a demonstrated bypass of the on-chain registry or that browser check.

**Next work:** configure the exact registry identity, require a unique authenticated output before decoding, validate its address/network and schema, and fail explicitly without replacing good state when authentication fails. Distinguish stale/unavailable registry state from an authenticated empty registry.

**Acceptance:** tests with forged-before-real, malformed-before-real, missing NFT, wrong quantity, multiple candidates, registry updates and rollback. Only the authentic output determines admission; status clearly reports failed synchronization. A minimal reproduction is in the appendix.

### R04 — P1: cancellation unnecessarily depends on valid acceptance terms

**References:** `contracts/dex/validators/bootstrap_offer.ak:34`, `contracts/dex/validators/bootstrap_offer.ak:66`, `tests/dex-bootstrap.test.mjs`.

`CancelBootstrap` calls `valid_offer`, which requires the input value to equal the datum-derived offer value exactly, as well as valid trading terms. Those are appropriate acceptance constraints but prevent the authenticated owner from recovering a malformed escrow.

**Reproduced with the compiled validator in Lucid's emulator:** an escrow with 4 ADA and 1,000 FT cancels when its datum declares 4 ADA; the same value with a datum declaring 3 ADA cannot build a cancellation, even with the owner signer and all input assets returned to that owner. Evaluation fails. Acceptance also requires the same exact-value check.

The current minimum-ADA pre-sign guard reduces one way to create this mismatch; it does not provide an on-chain escape for an output created by another client, incorrect terms, or extra assets. These malformed outputs may be irrecoverable under the deployed script. A UI patch or replacement deployment cannot change the validator locking an existing output.

**Next work:** separate cancellation authorization/refund invariants from acceptance validity. Require a trustworthy owner/key binding and return the actual escrowed value to that owner; do not weaken acceptance. Specify behavior for malformed/unparseable datums separately. Inventory existing offers before considering another deployment.

**Acceptance:** real-validator tests cover extra ADA, extra assets, invalid share/quote terms, attempted cancellation by a non-owner, and diverted/partial refunds. Valid acceptance and three-party separation still hold. Document explicitly what old outputs cannot be recovered; do not promise migration of an unspendable output.

### R05 — P1 decision: settlement safeguards depend on the trusted batcher

**References:** `contracts/marketplace/validators/quote_pool.ak:277`, `contracts/marketplace/validators/quote_pool.ak:386`, `contracts/marketplace/validators/quote_pool.ak:425`, `src/app/_components/team-workbench.tsx:95`, `src/app/_components/team-workbench.tsx:113`, `docs/UI_MODULES.md:53`.

`BatcherAcquire` and `BatcherInstantSell` require the configured batcher signature and exact value transitions, but do not enforce the resulting `min_cash_reserve` floor or an authenticated registry reference. `pool_can_pay` verifies affordability, not the protected floor. The Team UI performs those checks, but a different transaction builder using the authorized key can bypass them.

This is a **trusted-operator/security-model gap**, not a demonstrated attack by an arbitrary unsigned user. It was already acknowledged in the UI documentation. Product language about protected reserves and admitted assets must match the actual guarantee.

**Next work:** decide whether these are mandatory protocol invariants or explicitly trusted operating rules. If mandatory, enforce them in every relevant validator transition, with an authenticated registry reference and exact quote-asset accounting. Review inventory valuation/caps under the same trust model; UI prices are not a price oracle.

**Acceptance:** custom transactions signed by the legitimate batcher but crossing the reserve floor or buying an unadmitted asset are rejected if those guarantees are adopted. Test both quote-asset types and both acquisition paths. Otherwise record the accepted operator trust, monitoring and incident-response requirements prominently. Validator changes require a versioned deployment/migration plan, not just a UI release.

### R06 — P2: shared-pool closure cannot satisfy its minting policy

**References:** `contracts/marketplace/validators/quote_pool.ak:514`, `contracts/marketplace/validators/one_shot.ak:10`, `scripts/marketplace-preprod.mjs:70`.

`AdminClose` requires burning the pool identity token (`-1`). The deployment script creates that token with `one_shot`, whose only successful mint path requires consuming the original seed and minting exactly `+1`. There is no burn path. The closure branch and deployed identity policy therefore cannot be satisfied together. This finding is source-level; no public closure was attempted. The UI already lists shared-pool closure as unimplemented.

**Next work:** design closure and identity-policy lifecycle together, accounting for outstanding LP claims, inventory, the protected reserve, and authorized payout. Do not merely add a permissive burn path: the current close branch also does not require zero LP supply or explicitly constrain payout, so that would expose a separate authority/claim-safety issue.

**Acceptance:** end-to-end compiled-policy/validator closure succeeds only under the approved claims-settlement rules; unauthorized burn, open inventory and unresolved LP claims fail. Define a realistic path for existing deployments whose identity policy cannot be changed.

### R07 — P2: account switching can leave DEX recipient state stale

**References:** `src/lib/wallet-session.ts:58`, `src/app/_components/wallet-context.tsx:19`, `src/app/_components/dex-workbench.tsx:38`, `src/app/_components/dex-workbench.tsx:62`, `src/app/_components/dex-workbench.tsx:109`.

The shared session stores the address at connection time. It watches local-storage disconnects, not extension account/network changes. DEX refresh reads the wallet's live address/balances, while submission uses the stored context address for swap payouts without first asserting it still matches the signing account. Other flows, such as Team settlement and Portfolio mutations, already have explicit address-change checks.

If an existing CIP-30 handle begins returning the newly selected account, balances/inputs can describe that account while the payout still targets the old address. Exact extension behavior was not reproduced in this review; this is a source-level risk needing an account-switch integration test. The network check runs at connection and only establishes testnet ID `0`, not a complete ongoing Preprod session guarantee.

**Next work:** centralize a pre-build/pre-sign session assertion and invalidate quotes, role state and prepared transactions on detected changes. Reconnect explicitly when required by the wallet; use only supported network-identification capabilities and handle provider/wallet mismatch clearly.

**Acceptance:** mocked CIP-30 account changes and real Eternl switching cannot sign with stale recipients; network changes require revalidation; all transaction workbenches share the guard. Recheck after asynchronous approval work, not only on initial connection.

### R08 — P2: reload loses transaction and approval recovery state

**References:** `src/app/_components/dex-workbench.tsx:21`, `src/app/_components/dex-bootstrap-workbench.tsx:197`, `src/app/_components/team-workbench.tsx:38`, `docs/DEX_VALIDATION.md:55`.

Submitted hashes, bootstrap CBOR/witness handoffs and operator receipts live in React page state. A reload/navigation discards the UI's pending lock and confirmation controls. The transaction can still confirm, and a freshly built repeat operation may use different inputs. A timeout is not failure. Downloadable receipts are useful but do not constitute a durable audit trail or confirmation record.

**Next work:** persist a scoped pending-transaction journal with network, wallet, operation, hash, input references and status. Restore and reconcile it before permitting retry; provide safe import/export for multi-party approvals. Define witness retention/expiry and protect sensitive handoff data. Never store seed phrases/private keys.

**Acceptance:** reload after submission, delayed confirmation, competing input spends, canceled signatures, expired handoffs and wallet switching all produce recoverable, unambiguous status without an automatic duplicate operation. Durable operator receipts distinguish submitted from confirmed.

### R09 — P2: the wallet-provider error fix does not cover public readers

**References:** `src/lib/browser-chain-provider.ts`, `src/app/_components/wallet-context.tsx:21`, `src/lib/asset-registry.ts:120`, `src/app/_components/vault-workbench.tsx:71`.

Shared wallet initialization uses the validated browser provider. Registry and vault readers still construct raw `Blockfrost` providers. During a provider outage/malformed protocol-parameter response, those initialization paths can still reach Lucid's unchecked conversions and expose the old low-level BigInt failure instead of the actionable error. This is residual error handling, not evidence that the currently healthy endpoint is failing.

**Next work:** use one validated provider construction path for wallet and read-only clients; retain HTTP/schema checks and useful retry behavior.

**Acceptance:** inject 503, non-JSON, missing protocol parameters and valid responses into every initialization path; no `Cannot convert undefined to a BigInt` leaks to users. Never substitute invented protocol parameters to make transaction building proceed.

### R10 — P2: verification is not a reproducible deployment gate

**References:** `amplify.yml`, `package.json`, `contracts/minter/aiken.toml:3`, `tests/`, `infra/offchain/test/`.

The Amplify buildspec runs dependency installation and the Next build, but no JS/off-chain/Aiken tests. No checked-in GitHub workflow or Playwright/Cypress harness was found. Prior ad-hoc browser checks are not a maintained regression suite. The marketplace Aiken suite has only two `quote_pool` helper tests, not full coverage of its settlement and closure transitions; all three contract suites report zero property tests.

Fresh `aiken check --deny` in minter runs **19 passing tests but exits 1**, because `aiken.toml` requires **v1.1.19** and the installed compiler is **v1.1.21**. Terminal-mode output exposes that warning. Do not report the strict command as green or fix it by simply suppressing warnings. Compiler changes can change script identities.

**Next work:** pin compatible toolchains, add repeatable test/build gates, archive build provenance and verify committed blueprints against their intended compiler/source. Do not blindly overwrite deployed blueprints to satisfy CI. Add real-validator adversarial tests for R04–R06 and maintain the wallet/browser suite in the repository.

**Acceptance:** a clean checkout can run documented checks; CI prevents deploying failing tests; expected blueprints/derived identities match; intentional identity changes require reviewed manifests and migration. Include 320/390/1440px swap layouts, disconnected/connected flows, account switching, provider failures, reload recovery and three-party witness exchange.

### R11 — P2: deployment documentation points the next developer at another app

**References:** `docs/AMPLIFY_DEPLOYMENT.md:5`, `docs/DEX_VALIDATION.md:8`, `amplify.yml`.

The runbook names app `d2r4qj82rav2zq`, profile `catalyst`, account `515048575435`, and region `us-west-1`. The actual URL supplied for this work identifies app `d1g3uigoyq3hsb`. The named CLI profile is not installed locally; checks using the available profiles did not establish access to the actual app in the documented region. The actual hosting account, region, runtime role and branch mapping remain to be confirmed by its owner.

`DEX_VALIDATION.md` also records older counts (wallet 8, DEX 11); these are historical results, not the current baseline below. The runbook's `mainnet` environment description does not establish that Git `main` is a Mainnet deployment. The application remains deliberately Preprod-oriented.

**Next work:** reconcile the runbook with the active app, non-secret identifiers, deployment/SSR IAM roles, branch auto-deploy settings, price-store setup, secrets ownership and incident/rollback procedures. Link dated validation reports to their commit. Obtain cloud access from the owner instead of guessing accounts or uploading local credentials.

**Acceptance:** a newly onboarded developer can identify the correct app and logs, verify the deployed commit and API health, and follow an approved rollback procedure. Mainnet remains gated until separately deployed identities and network-safe configuration are verified.

## Remaining feature/workflow gaps

These are not all bugs and should not be silently bundled into a UI cleanup.

| Area | What exists | Missing decision or implementation |
| --- | --- | --- |
| Operator bootstrap | Offer creation, LP preparation, Team review/co-sign, submission; pool controls | Factory deployment is still CLI-only. Decide whether UI-guided setup is required; never move the local operator seed into the web app. R01/R04 must shape any deployment wizard. |
| Emergency recovery | Authorized partial FT burn returns the original NFT; recovery page warns about remaining fractions | Coordinated registry revocation, market warnings/delisting and liquidity retirement are not implemented. Remaining FT can circulate without their redemption claim. Define the multi-step authorized procedure and failure recovery before routine use. See `contracts/minter/validators/vault.ak:75` and `src/app/team/recovery/page.tsx:3`. |
| Shared-pool lifecycle | Pause and reserve controls | Closure is R06; authority rotation and repricing existing inventory are not delivered by the current controls. Define ownership and key-rotation procedures. |
| Traditional swap UX | From/To, direction switch, balance/quote/fee/impact display, exact-state execution | Native-token inputs are explicitly base units; no trusted decimals/symbol metadata layer or multi-hop routing. Pools require a connected wallet to be discovered in this component. Treat these as product scope, not an implied promise of Uniswap feature parity. |
| Real-wallet acceptance | Compiled-validator/emulator coverage and prior browser smoke checks | A documented, real three-wallet Eternl walkthrough for ADA and intended native quote asset, including declines, account switching, witness handoff and confirmation recovery. |
| Audit/operations | Downloadable operator receipt, CLI deployment pending manifest | Durable approvals/receipts and restored transaction status (R08), deployment health/version indicator and an agreed monitoring/incident owner. |

The emergency-recovery mechanism intentionally has a privileged trust assumption; this review does not recommend triggering it or claim remaining holders can redeem after recovery. Coordinate protocol, legal/product and operator decisions rather than hiding the warning in the UI.

## Fresh validation baseline

Environment: Node `v22.8.0`, Aiken `v1.1.21+42babe5`, Next `15.5.25`.

| Command/check | Result on baseline |
| --- | --- |
| `node --experimental-strip-types --test tests/*.test.mjs` | 57 passed, 0 failed |
| `npm run test:offchain` | 7 passed, 0 failed |
| `aiken check --deny` in `contracts/dex` | 6 passed; exit 0 |
| `aiken check --deny` in `contracts/marketplace` | 35 passed; exit 0 |
| `aiken check --deny` in `contracts/minter` | 19 passed; **exit 1**, compiler-version warning (R10) |
| `npm run lint` | Exit 0; 6 warnings, no errors |
| `npm run build` | Exit 0; optimized production build and type checking passed |
| Isolated registry authentication probe | Reproduced R03 with an in-memory store |
| Isolated bootstrap cancellation probe | 4 ADA datum/value control accepted; 3 ADA datum/4 ADA value rejected (R04) |
| Public Preprod reads | Results recorded above; no transaction submission |

Lint warnings: four unused destructured storage-key variables in `infra/offchain/runtime/api.mjs` and two raw image-element warnings in `src/app/_components/asset-browser.tsx`.

The fresh review did **not** complete a real-wallet signing walkthrough, prove historic LP recovery, inspect the active Amplify runtime/IAM configuration, exercise signed production price writes, run a load/penetration test, or rebuild/redeploy contract identities. Earlier browser checks are historical evidence, not newly executed acceptance tests in this round.

## Suggested next-developer sequence

1. Confirm cloud ownership and snapshot the current non-secret deployment configuration; restore and verify price storage (R02/R11).
2. Inventory current and historical pools/offers before any further redeployment. Preserve exact scripts and establish the legacy-holder recovery plan (R01).
3. Add failing regression tests for registry authentication and malformed cancellation; resolve the settlement trust model and close-policy design (R03–R06). Keep off-chain fixes separate from contract identity changes.
4. Implement session assertions, consistent provider errors, and durable transaction/approval recovery (R07–R09).
5. Make strict checks reproducible, check in the browser suite, and complete a supervised three-wallet Preprod acceptance record (R10).
6. Update operator/recovery/deployment documentation with verified identities and evidence. Only then scope any new contract deployment or Mainnet work for explicit approval.

## Appendix: minimal safe registry reproduction

Run from the repository root after installing the root and `infra/offchain` dependencies. It uses an in-memory fake store/provider, writes no chain data, and is expected to demonstrate the current bug. After fixing R03, replace it with repository regression tests that assert rejection.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { Data, Constr } from '@lucid-evolution/lucid';
import { createIndexer } from './infra/offchain/runtime/indexer.mjs';
const policy = 'ab'.repeat(28), name = '01', writes = [];
const datum = Data.to(new Constr(0, [999n, [new Constr(0, [policy, name])]]));
const store = {
  get: async () => null,
  queryKind: async () => ({ items: [] }),
  queryPartition: async () => ({ items: [] }),
  batchWrite: async items => writes.push(...items),
  put: async () => {},
};
await createIndexer({
  store, network: 'preprod',
  watchedAddresses: [{ kind: 'registry', address: 'addr_test1review' }],
  blockfrost: {
    latestBlock: async () => ({ slot: 1, height: 1, hash: 'review' }),
    addressUtxos: async () => [{
      tx_hash: 'forged', output_index: 0,
      amount: [{ unit: 'lovelace', quantity: '3000000' }],
      inline_datum: datum,
    }],
  },
})();
assert(writes.some(w => w.PutRequest?.Item.entity === 'supported-asset'
  && w.PutRequest.Item.unit === policy + name));
console.log('BUG reproduced: unauthenticated datum became a supported asset.');
JS
```

For the cancellation regression, reuse the fixture/schema in `tests/dex-bootstrap.test.mjs`: construct an owner-signed offer with 1,000 FT and 4,000,000 lovelace, but set datum `pool_lovelace` to 3,000,000; attempt redeemer `Constr(1, [])` cancellation returning the entire input value to the owner. `complete()` fails validator evaluation. Repeat with datum `pool_lovelace = 4,000,000` as the successful control. No factory input is needed for cancellation.
