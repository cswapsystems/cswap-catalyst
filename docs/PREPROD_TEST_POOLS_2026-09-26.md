# Preprod DEX test pools — 2026-09-26

The configured DEX factory in `dex-deployment.preprod.json` now contains two persistent test pools. Both use tADA as the quote asset. These are demonstration assets minted under a native signature policy controlled by the configured DEX administrator; they are not USDC or BTC, have no peg or redemption claim, and have no wallet decimal metadata. Token quantities below are integer base units.

| Pair | Test asset unit | Initial reserves | Pool NFT asset name | Creation transaction |
| --- | --- | --- | --- | --- |
| tADA/tUSDC | `cb80f8219868cca94ef54d8019cda2bc37564897edd64e9f705e78817455534443` | 100 tADA + 10,000 tUSDC units | `0000000000000000` | `e05aa49445f110cc8e7e4d4a40ec09519bf40c86c9dce0cd524e26399ffda2e7` |
| tADA/tBTC | `cb80f8219868cca94ef54d8019cda2bc37564897edd64e9f705e788174425443` | 100 tADA + 1,000 tBTC units | `0000000000000001` | `4395d9ae0b851ea148fac25d446c80a717c2fcb752e5ecd96943dfa41ae9b44b` |

One transaction minted 100,000 tUSDC and 10,000 tBTC units: `e7d310e0f5ec076978007731a5c2aebd53b37744bcaa747d4b9f937b90592646`. The administrator supplied both initial reserves and holds all initial LP shares: 1,000,000 for tUSDC and 316,227 for tBTC. These prices and supplies are arbitrary test values. The native signature policy can mint more tokens while its key is available; do not treat these symbols as authenticated external assets.

## Live swap checks

| Pair | Direction | Input | Confirmed transaction |
| --- | --- | --- | --- |
| tADA/tUSDC | tADA → tUSDC | 1 tADA | `0c8337370a5510b09c22347ca06d397eae36a04e17a77650685056e61a711ff0` |
| tADA/tUSDC | tUSDC → tADA | 10 tUSDC units | `785e0fef5affecb2a396f4a78e24e0862745b88631b57d63dffd0d38541b00a6` |
| tADA/tBTC | tADA → tBTC | 1 tADA | `2408859ad484903b854c602617b5d3b8cab741ed54318d6059066d9799f08fd6` |
| tADA/tBTC | tBTC → tADA | 10 tBTC units | `24370b15db49f9eb5556566b36ab74820d4488d023a6262dbdc5f640f8f17562` |

Post-swap read-only checks authenticated both pool NFTs, validator address, exact reserves and LP policy against the committed deployment. Factory sequence was 2. At that check, tUSDC held 100,898,409 lovelace and 9,912 token units; tBTC held 99,994,006 lovelace and 1,001 token units. These are dated observations, not fixed target balances. No test pool was closed. The hosted Preprod DEX API served the same deployment and 12 compiled validators as the local blueprint.

The general DEX acceptance suite also passed 24 isolated Preprod steps and rejected all 13 invalid transactions with both local and node evaluation. Its isolated pools were closed after testing. Marketplace P2P acceptance passed 38 steps and rejected 6/6 attacks. Local DEX checks passed 15 emulator/quote tests and 24 Aiken tests; local Marketplace checks passed 9 emulator/deployment tests and 50 Aiken tests. The Preprod production build and 14 browser regression tests passed. Those browser tests use mock wallets and do not replace a real Eternl three-wallet walkthrough or account-switching test.

Playwright cleared `test-results/` after these acceptance runs, removing their completed resumable journals. The harness now stores future journals under ignored `.data/preprod-test-journals/`, outside the browser output directory. The confirmed hashes above and the terminal summaries are the retained records for these runs; do not rerun a finished suite solely to recreate a journal, as that would create another isolated deployment and spend more test ADA.

## Verification

From the repository root, with the local Preprod admin wallet and Blockfrost settings:

```sh
npm run dex:preprod -- pool cb80f8219868cca94ef54d8019cda2bc37564897edd64e9f705e78817455534443
npm run dex:preprod -- pool cb80f8219868cca94ef54d8019cda2bc37564897edd64e9f705e788174425443
```

The commands above only read state. Pool reserve values change after swaps or liquidity actions. DEX pool discovery in the app requires a connected wallet; `/dex` reads and authenticates the current factory's pool outputs after connection. These pools belong to the current committed DEX factory, not the isolated test factory or older deployments.
