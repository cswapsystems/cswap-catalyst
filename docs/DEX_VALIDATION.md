# Three-party bootstrap validation

Validated with the compiled DEX blueprint and the confirmed Preprod deployment
in `dex-deployment.preprod.json`.

## Recorded redeployment results — 2026-09-25

| Check | Result |
| --- | --- |
| `aiken check --deny` in `contracts/dex` | 24 passed |
| Application Node unit suite | 89 passed |
| Off-chain tests | 23 passed |
| Playwright browser suite | 14 passed |
| `npm run build:preprod` | Passed |

See the [deployment record](PREPROD_REDEPLOYMENT_2026-09-25.md) for scope. These are recorded verification results, not a live test dashboard.

The DEX emulator tests execute the compiled validators, including ADA and
native-token bootstrap acceptance with separate LP and Team witnesses,
missing/reused signers, incorrect LP allocations, cancellation ownership,
stale requests, standard admin pool creation, and hostile approval CBOR.
Review tests reject Team collateral, governance donations, extra signers,
unexpected mints, and mismatched deployments. Minimum-ADA tests reproduce
automatic balancing that would invalidate an exact-value escrow and verify
the pre-signing guard rejects it.

## Browser and chain checks

The browser suite checks responsive navigation and disconnected, ordinary-wallet and authorized-wallet operator guards. Read-only checks against the new deployment verified the factory state and UI-derived bootstrap compatibility without submitting a transaction. A successful local check does not establish that Amplify has published the same commit.

Preprod factory transaction:
`fb56ba304c6cd646517f0b87da25d5f67158ec18adbcd0aaaceb58d21ae03e49`.
Confirmation was followed by independent reads verifying the singleton NFT
at the configured factory address, admin, pool policy, sequence zero, and
unpaused datum. The fresh factory had no pools/offers at verification. The previous factory (`02286df2…b6a14f6`) and older offers, pools and funds were not migrated or changed.

## Remaining acceptance work

This is not an independent security audit. A real three-wallet Eternl
walkthrough remains necessary: create/cancel an offer, prepare an LP request,
review and sign with Team, return the witness, submit, and check both LP
balances. Repeat for the intended native quote asset and exercise declined
signatures, wallet switching, and confirmation timeouts. Emulator signatures
and disconnected-browser checks do not prove extension interoperability.

Pending transactions and approval handoffs are page-session state; preserve
their hashes/CBOR before navigating away. Factory deployment is still a CLI
operation; the operator UI coordinates bootstrap offers and pool lifecycle.

## Follow-up acceptance — 2026-09-26

The isolated Preprod DEX suite passed 24 transaction steps and rejected 13/13 invalid transactions in both local and node evaluation, including swaps, liquidity, ADA/token quote bootstraps, offer recovery and closure authorization. Its test pools were closed. Two separate, persistent tADA/tUSDC and tADA/tBTC pools were then created under the configured factory; each completed swaps in both directions. Exact asset units, creation/swap hashes, initial reserves and post-swap state are in [the test-pool record](PREPROD_TEST_POOLS_2026-09-26.md). Local DEX tests passed 15/15, Aiken passed 24/24, the Preprod build passed, and browser regressions passed 14/14. The hosted DEX API matched the committed deployment and validator bytecode. Real Eternl three-wallet/account-switching acceptance remains outstanding.
