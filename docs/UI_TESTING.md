# UI regression checks

These checks cover navigation, route organization, operator access and wallet interaction. The [developer review](DEVELOPER_HANDOFF_REVIEW.md) is a historical baseline; use the [2026-09-25 redeployment record](PREPROD_REDEPLOYMENT_2026-09-25.md) for subsequent fixes and validation. Passing these checks does not certify production readiness.

## Repeatable local checks

Use a current Node 22 release (22.13 or later satisfies the installed lint tooling's engine range):

```sh
npm ci
node --experimental-strip-types --test tests/*.test.mjs
npm run lint
npm run build:preprod
npx playwright install chromium
npm run test:browser
```

The browser suite starts its own production server on `127.0.0.1:3105`; leave that port free. Build before rerunning after application changes. If Chromium is already installed, use its explicit path instead of downloading the test browser:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser
```

`tests/navigation.test.mjs` checks menu destinations, section ownership, aliases and active-route mapping. `tests/browser/navigation.spec.ts` checks:

- Primary navigation and page overflow at 320, 390, 768 and 1440px.
- Keyboard opening, Escape/focus restoration, outside dismissal and route-change closure.
- Portfolio workflow links, active page/section state and skip-to-content focus.
- Redirects away from obsolete screens and removal of dead footer actions.
- Actionable provider-failure messages and an isolated mocked CIP-30 account menu, including explicit disconnect.
- Locked direct operator routes for disconnected/ordinary wallets, public registry access, and revocation of operator access on mocked account changes or disconnection.

Browser API requests are intercepted; mock responses and a fake wallet are used. No real wallet keys, live service credentials, or chain submissions are needed by the tests. Traces/screenshots for failures are written under ignored `test-results/`. This is navigation/interaction coverage, not proof of real Eternl signing, successful swaps, price-store availability, or validator safety. Production build environment requirements remain those of the application.

For real-browser Preprod acceptance with separate wallet roles, on-chain confirmation, and recovery checks, use the [manual browser test plan](MANUAL_BROWSER_TEST_PLAN.md). Its write cases spend test assets and are not part of the automated suite.

Amplify gates builds on the Node application unit suite. Playwright, Aiken and off-chain suites are not currently Amplify gates. Real three-wallet acceptance and real Eternl account switching during approval remain separate manual work.

## Recorded redeployment validation — 2026-09-25

The redeployment verification recorded 89 application tests, 14 browser tests, 50 Marketplace Aiken tests and 24 DEX Aiken tests passing, plus 23 off-chain tests and the Preprod production build. Read-only chain checks verified the new manifests. These are dated results, not a claim that every subsequent change was retested or that a hosted build has been published. Indexer deployment remains deferred.

After pulling validator-renaming commit `02efae6`, the documentation refresh reran all 89 application tests and 23 off-chain tests successfully. Local derivation confirmed the Marketplace blueprint still matches the committed addresses, policies and burn-capable identity; watched-address consistency is included in the application suite. Browser, Aiken and build results above remain the earlier deployment verification, not fresh runs in this documentation-only pass.

## Historical refinement validation — 2026-09-23

- All 61 application tests passed, including four new navigation-model tests.
- All 11 browser tests passed against the production build using local Chrome. The layout matrix covered ten pages at each of the four viewport widths.
- Production build and type checking passed.
- Lint passed with the six existing warnings (four unused storage-key bindings and two image-element warnings); no new lint errors.
- `npm audit` reported zero vulnerabilities after a compatible development-only `js-yaml` update from 4.3.1 to 4.3.2.
- Desktop and mobile screenshots were visually reviewed. The first run exposed a 320px owner-listings overflow; the corrected grid and stacked heading passed the final run.

No contract source, blueprint, deployment identity, hosted configuration or signing logic was changed. These results do not establish a successful hosted deployment; the refinement was tested locally.
