# Three-party bootstrap validation

Validated with the compiled DEX blueprint and the confirmed Preprod deployment
in `dex-deployment.preprod.json`.

## Automated results

| Check | Result |
| --- | --- |
| `aiken check --deny` in `contracts/dex` | 6 passed |
| `aiken build` in `contracts/dex` | Blueprint rebuilt |
| `npm run test:registry` | 5 passed |
| `npm run test:wallet` | 8 passed |
| `npm run test:wallet-assets` | 4 passed |
| `npm run test:metadata` | 6 passed |
| `npm run test:offchain` | 7 passed |
| `npm run test:dex` | 11 passed |
| `npm run test:ui` | 16 passed |
| `npx tsc --noEmit` | Passed |
| `npm run lint` | No errors; 6 existing warnings |
| `CSWAP_NEXT_DIST_DIR=.next-review npm run build` | Passed |

The DEX emulator tests execute the compiled validators, including ADA and
native-token bootstrap acceptance with separate LP and Team witnesses,
missing/reused signers, incorrect LP allocations, cancellation ownership,
stale requests, standard admin pool creation, and hostile approval CBOR.
Review tests reject Team collateral, governance donations, extra signers,
unexpected mints, and mismatched deployments. Minimum-ADA tests reproduce
automatic balancing that would invalidate an exact-value escrow and verify
the pre-signing guard rejects it.

## Browser and chain checks

An isolated headless Chrome session against the production build checked
`/team/dex`, `/dex/launch`, and `/marketplace` at 1440px and 390px widths:
HTTP 200, no page runtime errors, no horizontal overflow, and correct
disconnected-wallet review/signing guards. The bootstrap default is 4 ADA;
the deployment mismatch warning is cleared and the workspace reports Ready.

Preprod factory transaction:
`02286df2d4da548a90ed9c78a94e7055b0fe59c1e474e1a164dbe0310b6a14f6`.
Confirmation was followed by independent reads verifying the singleton NFT
at the configured factory address, admin, pool policy, sequence zero, and
unpaused datum. No old offers, pools, or funds were migrated.

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
