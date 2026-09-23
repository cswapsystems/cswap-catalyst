# UI regression checks

The navigation refresh changes presentation, route organization and entry points, not contract identities or transaction settlement rules. It does not resolve the contract/deployment blockers in `DEVELOPER_HANDOFF_REVIEW.md` or certify production readiness.

## Repeatable local checks

Use a current Node 22 release (22.13 or later satisfies the installed lint tooling's engine range):

```sh
npm ci
node --experimental-strip-types --test tests/*.test.mjs
npm run lint
npm run build
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

Browser API requests are intercepted; mock responses and a fake wallet are used. No real wallet keys, live service credentials, or chain submissions are needed by the tests. Traces/screenshots for failures are written under ignored `test-results/`. This is navigation/interaction coverage, not proof of real Eternl signing, successful swaps, price-store availability, or validator safety. Production build environment requirements remain those of the application.

The new suite is checked into the repository but is not yet wired into Amplify's deployment gate. Cloud pipeline changes and real three-wallet acceptance remain separate work.

## Refinement validation — 2026-09-23

- All 61 application tests passed, including four new navigation-model tests.
- All 11 browser tests passed against the production build using local Chrome. The layout matrix covered ten pages at each of the four viewport widths.
- Production build and type checking passed.
- Lint passed with the six existing warnings (four unused storage-key bindings and two image-element warnings); no new lint errors.
- `npm audit` reported zero vulnerabilities after a compatible development-only `js-yaml` update from 4.3.1 to 4.3.2.
- Desktop and mobile screenshots were visually reviewed. The first run exposed a 320px owner-listings overflow; the corrected grid and stacked heading passed the final run.

No contract source, blueprint, deployment identity, hosted configuration or signing logic was changed. These results do not establish a successful hosted deployment; the refinement was tested locally.
