# Preprod manual browser test plan

Use this runbook to test the deployed application with real browser wallets. It covers the Marketplace, on-chain registry and price entries, Portfolio, DEX, and three-party pool bootstrap. Record what actually happened; a visible success message is not proof of on-chain confirmation.

Target: <https://preprod.d1g3uigoyq3hsb.amplifyapp.com>. This document was written against repository commit `88e0b3b` (2026-09-28). Before signing anything, confirm the Amplify deployment completed for that commit or a newer reviewed commit. If you cannot establish the deployed revision, mark signing tests **blocked**. The app is on Preprod/testnet, not mainnet.

## Safety and test data

- Use disposable test ADA and test assets only. Every wallet signature can incur fees or move assets. Never enter or share a seed phrase, private key, or wallet recovery words in the app, a ticket, or this results sheet.
- Use separate browser profiles or devices for each participant in the three-party flow. Record public wallet addresses and transaction hashes only. Treat unsigned transaction CBOR and approval witnesses as sensitive handoff material; transfer them privately, and do not attach them to public issues.
- Check the wallet network and the full account address before **every** signature. Reject a wallet prompt if its inputs, outputs, amount, or recipient differ from the on-screen review. Never repeatedly submit after a timeout: first check the transaction hash in a Preprod explorer and refresh the app state.
- Use synthetic metadata and documents. Mint uploads are published to IPFS and should be treated as permanent and public. Do not upload real identity or legal records.
- Do not routinely test registry revocation, emergency recovery, pool destruction, final LP exit, or production-like asset removal. Those need their own approved, destructive-operation runbook.
- The existing `tUSDC` and `tBTC` are **unpegged demo tokens**, not real or redeemable USDC/BTC. Amounts are integer base units unless the UI explicitly says otherwise. For ADA fields, confirm whether the form asks for ADA or lovelace (`1 ADA = 1,000,000 lovelace`).

Prepare and label these wallets. A person may hold more than one role, but the FT provider, LP provider, and Team creator must use **distinct wallet addresses** for a three-party bootstrap.

| Label | Required capability | Used for |
| --- | --- | --- |
| S — seller/issuer | Disposable original RWA NFT or fungible asset, test ADA | Listings, Instant Sell, registry request, optional mint |
| B — buyer | Test ADA or listing payment token | Buy a listing, verify ownership |
| O — Team/operator | Configured operator/issuer/batcher permissions, test ADA | Approval, acquisition, registry decisions, on-chain prices |
| F — FT provider | Demo FT and test ADA | Lock FT bootstrap offer |
| L — liquidity provider | Quote asset and test ADA | Bootstrap funding, LP operations |
| T — Team creator | Configured DEX creator wallet, test ADA | Review and sign pool creation |

Identify O and T from the deployed configuration; do not assume that the same wallet has every privilege. Have a second ordinary wallet available to test denied access. Keep an inventory of starting ADA, FT, NFT, LP token, and shared-reserve balances. Use a small disposable budget for each write test.

Suggested existing DEX pairs are tADA/tUSDC and tADA/tBTC. Their demo-token units are recorded in [the test-pool record](PREPROD_TEST_POOLS_2026-09-26.md); verify the unit and current pool before selecting either token. Do not create a duplicate pool just to run basic swap tests.

## Recording results

For each case, record `PASS`, `FAIL`, `BLOCKED`, or `N/A`, the wallet label, browser/device, deployed commit, timestamp and timezone, starting/ending balances, transaction hash (if any), and a screenshot of the result or error. For an on-chain write, record both submission and independent confirmation. Redact wallet extension details and handoff material from screenshots before sharing.

Stop and report a **critical** defect if the app offers a signature to the wrong address/network, signs after a wallet account change, permits an unapproved role to sign a privileged action, calculates an implausible amount, or allows a duplicate submit while a transaction is unresolved. A rejected signature is not a completed transaction. A missing indexer result alone is not proof of failed settlement; verify chain state independently. The indexer deployment is intentionally deferred and is not part of this script.

## Phase 1 — release and read-only smoke checks

Perform these before spending any test ADA.

| ID | Browser actions | Expected result |
| --- | --- | --- |
| P01 | Open the Preprod URL in a fresh profile. Confirm the Amplify build revision through the deployment dashboard or release owner. Navigate Marketplace, Swap, Portfolio, Create, and Protocol. | No blank page, hydration error, broken route, or console exception. Revision is confirmed before signing. |
| P02 | With no wallet connected, open `/marketplace`, `/dex`, `/my-assets`, `/portfolio/asset-requests`, `/registry`, `/team`, `/team/inventory`, `/team/dex`, and `/dex/launch`. | Public data can be read where intended; signing controls require a wallet. The owner request page is accessible, while `/registry` and other operator controls are locked. |
| P03 | Connect ordinary wallet B, then open the Operations menu and `/team`, `/team/inventory`, `/team/controls`, `/team/dex`, and `/team/recovery` directly. Repeat with O/T as appropriate. | Ordinary wallet cannot operate privileged controls, including through a direct URL. Authorized wallet sees only its applicable actions. Treat UI gating as a usability check, not a substitute for on-chain authorization. |
| P04 | Switch Eternl to the wrong network, reconnect, and inspect each transaction-capable page without signing. Return to Preprod. | Wrong-network state is explicit and signing is disabled or safely rejected. No `Cannot convert undefined to a BigInt` or silent wallet failure. |
| P05 | Open `/marketplace` and `/dex` while disconnected and after connecting. Inspect loading, empty, and loaded states; use visible Refresh buttons. | Current listings, prices, and pools display with correct units; no incompatible-blueprint signing warning on a reviewed deployment. If such a warning appears, stop write tests and report it. |
| P06 | At widths approximately 320, 390, 768, and 1440 px, open navigation and each major page. Navigate using Tab/Shift-Tab/Enter/Escape. | Menus and wallet control are reachable, focus is visible, dialogs can be closed, and forms are usable without horizontal overflow or hidden primary actions. |
| P07 | Open Portfolio **Open positions**, **Listings & requests**, **Shared liquidity**, and **Activity**. Open Protocol **Overview**, **Approved assets**, and **Vault activity**. Compare the same asset/transaction across applicable screens. | Links land on the expected screens; confirmed holdings, orders, LP positions, approvals, vault state, and history agree. Pending transactions are not reported as confirmed activity. Empty states explain what to do next. |
| P08 | As O/T, inspect Operations **Shared pool**, **DEX controls**, and **Deployment wallets** without signing. As an ordinary wallet, visit the same routes. | Authorized control pages identify current state and relevant addresses without revealing secrets. Ordinary wallet cannot activate privileged controls. Do not pause/destroy a pool or change protocol controls in this routine run. |

## Phase 2 — Portfolio, registry, and Marketplace P2P

Use one disposable asset for the listing flow and a separate disposable original RWA NFT for registry/Instant Sell if possible. Wait for confirmation between dependent steps. Tests marked **write** spend fees or move tokens.

| ID | Browser actions | Expected result |
| --- | --- | --- |
| M01 | As S, open `/my-assets`, locate an owned disposable asset, and inspect its quantity, metadata, provenance link, and available actions. Open `/assets?asset=<unit>` for the same unit. | Unit, quantity, and ownership agree across Portfolio and asset detail. The asset is not presented as another wallet's holding. |
| M02 · write | From S's asset, choose **Sell / List** → **List on Marketplace**. Enter a valid quantity and **Total lot price**; leave payment asset ID blank for ADA. Review the wallet prompt and create the listing. | A transaction hash appears. Once confirmed, the listing appears on `/marketplace` and `/portfolio/orders` with the exact asset, quantity, seller, payment asset, and total price. S cannot buy its own listing. |
| M03 | As S, inspect the listing in `/portfolio/orders`; as B, inspect it in `/marketplace`. Try zero, excessive, or malformed quantity/price without signing. | Owner management is visible only to S. Invalid inputs are rejected before a wallet prompt; no chain transaction occurs. |
| M04 · write | As B, buy a small listing after checking the wallet outputs and any minimum-ADA requirement. Refresh both wallets after confirmation. | B receives the listed quantity; payment goes to the expected party; listing closes or updates correctly; S and B balances reconcile with fees. Record the hash. |
| M05 · write | Create a second disposable listing, then edit or cancel it from S's `/portfolio/orders`. Do not cancel a listing another tester may be buying. | Only its owner can manage it; confirmed chain state and Marketplace display reflect the edit/cancellation. Escrowed assets return on cancellation, less fees. |
| R01 | As S, open Portfolio → **Asset support** (`/portfolio/asset-requests`). Inspect your pending requests and select an eligible **original RWA** asset for **Request support**. As an ordinary wallet, try `/registry` directly. | Owner page identifies asset/unit and fee before signing, shows only this wallet's pending requests, and contains no issuer controls. A fractional token or ineligible asset cannot be requested; `/registry` stays operator-gated. |
| R02 · write | On a disposable RWA, submit **Request shared-pool support · 3 tADA**. Confirm the displayed payment and wallet outputs first. | Request appears pending after chain confirmation. The original owner can see **Cancel & refund**; O/issuer can see review actions. Note actual refund/fee terms shown by the wallet. |
| R03 · write | Have O/issuer inspect the request at `/registry` and approve only the reviewed disposable asset, or have S cancel it from `/portfolio/asset-requests` if approval is not desired. | Confirmed registry status changes and persists after reload. The request leaves S's pending list. Approval alone does **not** create an on-chain pool price or guarantee that Instant Sell is available. |
| M06 | As S, open **Instant Sell to pool** on a supported asset. Inspect the quote, minimum, quantity, pool liquidity, and stated escrow/ADA buffer. Try an unsupported asset or absent price. | Valid quote identifies exact asset and current on-chain price; missing support/price or insufficient available reserves blocks submission with an actionable reason. |
| M07 · write | With a reviewed price and adequate shared reserves, submit **Request sale at this minimum** for a small quantity. O then reviews it in `/team` under **Approve Instant Sell listings** and uses **Sign acquisition** with the required approval reference. Save **Download approval receipt** privately. | Request and approval reference are visible to the relevant parties. Pool acquisition uses the reviewed minimum/quantity, updates inventory and reserves after confirmation, and leaves an auditable transaction hash. The session-only receipt matches the action but is not proof of confirmation. Do not approve a request you did not verify. |
| M08 · write | For a separate disposable pending request, test S's cancellation **before** O acquires it. | Request closes and escrow returns according to the displayed terms. It cannot later be acquired. If no spare request/budget exists, mark N/A. |
| M09 · write | Buy a small amount of acquired pool inventory as B, if inventory is available. | Buyer receives the asset; pool cash/inventory changes exactly as the on-chain price and fees imply. Existing requests are not retroactively repriced. |

For a Marketplace transaction that remains pending, see F04 before making another attempt.

## Phase 3 — on-chain prices and shared reserves

These tests affect a shared live testnet pool. Coordinate with other testers; use a disposable asset/quote pair and restore an old value only through a new reviewed on-chain transaction. Record the previous price before editing.

| ID | Browser actions | Expected result |
| --- | --- | --- |
| O01 | As O/batcher, open `/team/inventory`. Inspect the fixed pool quote asset and ID, on-chain price rows, exact asset units, and seller/buyer quote amounts for their stated asset quantities. Click **Refresh pool**. | Refreshed rows match chain state. ADA input/display uses tADA while the contract stores lovelace; native quotes use integer base units. No per-price quote selector, off-chain operator price book, or duplicate price source appears. |
| O02 | Select a reviewed asset from the issuer registry, use **Edit draft** on an existing approved asset, change the seller payout or buyer ask **for an asset quantity**, then **Add / update draft**. Reload **before signing** and try **Discard draft**. | Only registry-approved assets can be newly priced or edited in this UI; the selection is not an on-chain validator rule. Draft is clearly uncommitted and discard/reload leaves chain state unchanged. Zero amounts, malformed ADA precision, and zero asset quantities are rejected. |
| O03 · write | Stage a reviewed small price update, inspect the complete transaction, and use **Sign on-chain price update**. Wait for confirmation; refresh as O and B. | The updated exact-asset entry appears consistently in Team, quote, Marketplace/Instant Sell, and any relevant asset display. Only the authorized batcher can publish. |
| O04 | Stage **Remove price from draft** for a disposable asset but discard it. If a separate approved removal test is authorized, sign it and check any pre-existing pending requests independently. | Draft removal has no chain effect. A confirmed removal blocks **new** acquisitions for that asset; it does not cancel pending requests or reprice existing inventory. |
| L01 | Open `/portfolio/reserves` as L and read **Shared reserves & LP exits**. For deposit and top-up, enter `1.5` and verify the preview says 1.5 ADA; try `0`, `0.0000001`, and malformed values without signing. For withdrawal, enter a whole LP-unit count, then try fractional and excess counts. | Preprod shows tADA cash/protected reserve and ADA payouts. Deposit/top-up inputs are ADA, converted to lovelace for the transaction; withdrawal input is LP units, not ADA. Invalid or reserve-breaking actions are blocked. |
| L02 · write | If a disposable LP position and budget exist, make a small **LP deposit** in ADA and later a **non-final** cash-only withdrawal by LP-unit count. Alternatively make a small ADA top-up and verify it mints no shares. | Confirmed reserve and LP balances match the previews, within documented rounding. Protected reserve stays intact. Never test the final LP exit in this routine run. |

## Phase 4 — mint and fractional ownership

These are optional paid writes if no safe disposable files/assets are available. Still run the read-only checks and record why any write is N/A.

| ID | Browser actions | Expected result |
| --- | --- | --- |
| C01 | Open `/mint` as S. Try invalid/oversize files, omitted required metadata, and cancel the review. Use only synthetic PNG/JPEG/WebP image and synthetic PDF authenticity file, each at most 5 MB. | Validation is clear before signature; a cancelled review does not mint. Public-storage confirmation accurately warns about IPFS publication. |
| C02 · write | Enter synthetic RWA metadata, **Review and mint**, verify the full public data and wallet outputs, then sign. | After confirmation, the new original NFT appears in `/my-assets` and its asset detail page with the intended metadata/image/provenance. Do not publish personal or confidential data. |
| C03 · write | On a separate disposable original NFT, open `/fractionalize` or Portfolio **Fractionalize**, enter a small whole-number fraction supply, then **Review & fractionalize** and sign. | Original NFT is locked in the vault; fractions appear in the owner wallet; `/vault` and asset detail show consistent state. Ordinary listing/registry eligibility must not misidentify fractions as originals. |
| C04 · write | Only if S still holds the **entire** fraction supply, use **Combine** and inspect the transaction before signing. | Fractions burn and the original NFT returns after confirmation. If supply has been transferred or listed, stop and mark N/A; do not try emergency recovery. |

## Phase 5 — DEX swaps and ordinary liquidity

Use an existing reviewed pool, preferably the documented tADA/tUSDC or tADA/tBTC demo pool. Compare wallet balances and pool reserves against an explorer before and after. Price movement is expected; demo tokens have no USD peg.

| ID | Browser actions | Expected result |
| --- | --- | --- |
| D01 | Open `/dex`, choose **From** tADA and **To** a demo token, enter several small amounts, then use **Reverse swap direction**. Inspect estimated output, **Minimum received**, fee, price impact, and insufficient-balance state. | Pair and amount follow the reversal correctly; output/minimum use the correct token unit; zero, missing pool, excessive size, and insufficient balance cannot be signed. Quote refreshes after amount/pair change. |
| D02 · write | With a small reviewed amount, sign a tADA → demo-token **Swap**. Wait for confirmation and refresh the pool and Portfolio. | Received amount is at least the stated minimum, fee/price impact are plausible, and reserves/balances change consistently. Record quote time and hash. |
| D03 · write | Swap a small amount in the reverse direction using the updated pool state. | Correct input token is spent, tADA is received, minimum is respected, and the UI does not reuse the prior direction's quote. |
| D04 | Open `/dex/liquidity`. Inspect **Add liquidity** and **Remove liquidity**, reserve ratio, required wallet holdings, share estimate, and invalid inputs. | The app indicates the exact amounts and LP result before signing; insufficient token/ADA balances and zero amounts block signing. |
| D05 · write | Add a small amount of both sides in the required ratio. After confirmation, remove only part of the newly acquired LP position. | LP tokens appear on add; both reserve tokens return on partial removal; pool remains active; reserve/share math reconciles with rounding and fees. |

## Phase 6 — three-wallet pool bootstrap

This is a separate end-to-end test, not required to validate an existing pool. It creates a new pool and spends test assets. Obtain a fresh, unique FT/quote pair and an agreed budget. Never reuse an existing pair merely to make this test pass. The FT provider F, liquidity provider L, and Team creator T must be three distinct wallet addresses. Keep L's browser tab open throughout the approval handoff; the in-progress handoff is page-local and may be lost on reload.

| ID | Browser actions | Expected result |
| --- | --- | --- |
| B01 | In F's profile open `/dex/launch`. Check FT unit, FT amount in base units, quote asset, final reserve, ADA buffer, LP share, participant addresses, and balance. Try F=L or F=T and invalid/underfunded values without signing. | Three-party roles and economics are explicit; same-address or invalid configurations are rejected. Do not confuse whole ADA shown in this form with lovelace on other forms. |
| B02 · write | F clicks **Create bootstrap offer**, checks the escrow transaction in Eternl, signs, and waits for confirmation. Record the offer reference and hash. | FT offer appears in the available offers with exact pair, quantity, owner, and terms. FT/ADA escrow and fees reconcile. |
| B03 | Optional cancellation drill: create a *separate* disposable offer and have F use **Cancel offer** before L funds it. Do not cancel the offer used below. | Confirmed cancellation returns escrow subject to fees, and the offer cannot be funded. |
| B04 | In L's separate profile select F's confirmed offer and review the quote-side funding and resulting LP allocation. Click **Fund & request Team approval**. | L receives an **Approval transaction CBOR** for this exact offer. The transaction has not yet been submitted; no pool should appear merely because CBOR was generated. |
| B05 | Transfer that CBOR privately to T. In T's profile paste it into **LP approval transaction CBOR**, click **Review bootstrap request**, and compare full addresses, pair, reserves, LP split, inputs/outputs, fee, and Team input/collateral expectations with the agreed plan. | Review clearly identifies all three participants and rejects altered or wrong-pair CBOR. If anything differs, reject and stop; do not sign. |
| B06 | T checks the review acknowledgement and clicks **Create Team approval witness**. Transfer **Generated Team approval witness** privately to L. | Only configured Team creator can produce a valid approval witness. This is an authorization artifact, not a submitted transaction. |
| B07 · write | L pastes the Team witness, clicks **Submit Team-approved pool**, checks the final wallet prompt, and signs once. Wait for chain confirmation. | Pool appears for the exact FT/quote pair in `/dex/liquidity` and `/dex`; F/L LP ownership and reserves match the agreed split. Record transaction hash, balances, and pool address. |
| B08 | As an ordinary wallet, refresh both DEX pages and quote a tiny swap without signing. | Pool is publicly discoverable and quoteable. If explorer confirms pool creation but the UI does not show it, report an indexing/display failure rather than retrying pool creation. |

## Phase 7 — failures, persistence, and account safety

Run destructive-looking negative tests only with disposable transactions. Reject wallet prompts; do not deliberately submit malformed or adversarial transactions.

| ID | Browser actions | Expected result |
| --- | --- | --- |
| F01 | Start a small disposable listing or swap, then **reject** the Eternl signature prompt. | App returns to a usable state with a clear cancellation message; no hash is claimed and no funds move. A fresh attempt is possible. |
| F02 | Start building a disposable transaction, switch the active Eternl account **before** the final wallet prompt, and observe the app. Do not sign under the changed account. | App detects the account change or safely aborts; it never signs with stale assumptions, old inputs, or an unexpected recipient. Record the exact stage and wallet addresses. |
| F03 | Use browser DevTools to simulate offline service access on a read/quote page, then restore connectivity and refresh. Do not sign while offline. | Recoverable error and retry control appear; no blank page, `BigInt(undefined)`, or misleading successful quote. |
| F04 · write | Submit one small Marketplace transaction and capture its hash; before confirmation, reload `/marketplace` or `/my-assets`. Use **Check confirmation** after explorer confirmation. | Pending transaction journal restores after reload and blocks duplicate Marketplace signing until resolved. A timeout is not treated as proof of failure. If hash remains unresolved, stop and escalate rather than clearing browser storage or resubmitting. |
| F05 | For a DEX, direct Portfolio listing, registry, or bootstrap write, capture the hash immediately and inspect it in an explorer after any timeout/reload. | Tester can reconcile chain state independently. Do not assume those flows share Marketplace's durable pending journal; do not retry blindly. |
| F06 | Disconnect/reconnect each wallet and navigate between pages. Change browser tab visibility and refresh once when no transaction is pending. | Correct address and permissions refresh; data is not incorrectly retained from the previous wallet. No runtime exceptions or stale privileged actions. |

## Closeout and handoff

1. Reconcile each write against an explorer and wallet balances. Compare any escrowed asset, LP shares, pool reserves, and listing status with the starting inventory. A submitted but unconfirmed hash remains **pending**, not PASS or FAIL.
2. Close or cancel only disposable offers/listings/requests that you own and are safe to close. Do not undo an approved registry asset, active pool, live price, or another tester's transaction without a separate coordinated decision. Record any test objects left on chain.
3. File defects with case ID, deployed commit, public wallet role/address, network, UTC time, browser and Eternl versions, steps, expected/actual result, transaction hash, and redacted screenshot/console error. Never include seed phrases, keys, raw witnesses, or private documents.
4. Mark the release ready only when P01–P06 and the applicable Marketplace/DEX happy paths pass, every submitted transaction is reconciled, and no critical safety defect remains. Record N/A for optional mint/bootstrap writes rather than claiming they passed.

Reusable row: `Case ID | PASS/FAIL/BLOCKED/N/A | wallet role | date/time | tx hash | observed result | evidence link | defect ID / follow-up`.
