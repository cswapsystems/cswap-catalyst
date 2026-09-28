import { test, expect, type Page } from "@playwright/test";
import { CML, PROTOCOL_PARAMETERS_DEFAULT } from "@lucid-evolution/lucid";
import deployment from "../../marketplace-deployment.preprod.json";

test.beforeEach(async ({ page }) => {
  // Never depend on real credentials or submit a transaction in navigation tests.
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { error: "Offline navigation test" } }));
});

for (const width of [320, 390, 768, 1440]) {
  test(`navigation and workflow layouts fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const path of ["/my-assets", "/team", "/dex", "/mint", "/portfolio/orders", "/portfolio/asset-requests", "/fractionalize", "/marketplace", "/wallet", "/protocol", "/team/dex", "/team/inventory", "/team/controls", "/portfolio/reserves"]) {
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link")).toHaveText(["Marketplace", "Swap", "Portfolio", "Create"]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), path).toBe(true);
      await expect(page.locator(".app-network-label")).toHaveText("Preprod · Testnet");
      await expect(page.locator("#main-content")).toHaveCount(1);
      if (path === "/my-assets" || path === "/team") await page.screenshot({ path: test.info().outputPath(`${path.slice(1)}-${width}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}

test("More menu works by keyboard, closes on Escape/outside click, and resets after navigation", async ({ page }) => {
  await page.goto("/my-assets");
  const summary = page.locator("summary").filter({ hasText: "More" });
  const disclosure = page.locator("details").filter({ has: summary });
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("open", "");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Protocol overview Public deployment statistics" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
  await summary.click();
  await page.getByRole("heading", { name: "Your holdings" }).click();
  await expect(disclosure).not.toHaveAttribute("open", "");
  await summary.click();
  await expect(page.getByRole("link", { name: /Operator console/ })).toHaveCount(0);
  await expect(page.locator(".header-menu-disabled")).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("link", { name: "Protocol overview Public deployment statistics" }).click();
  await expect(page).toHaveURL(/\/protocol$/);
  await expect(page.locator("details[open]")).toHaveCount(0);
});

test("portfolio workflows lead to focused pages and keep the active section", async ({ page }) => {
  await page.goto("/my-assets");
  await expect(page.getByRole("heading", { name: "Your open positions", exact: true })).toHaveCount(0);
  await expect(page.locator(".portfolio-links")).toHaveCount(0);
  await page.getByRole("region", { name: "Portfolio workflows" }).getByRole("link", { name: /Open positions/ }).click();
  await expect(page).toHaveURL(/\/portfolio\/positions$/);
  await expect(page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Portfolio", exact: true })).toHaveAttribute("aria-current", "location");
  await expect(page.getByRole("navigation", { name: "Portfolio navigation", exact: true }).getByRole("link", { name: "Open positions" })).toHaveAttribute("aria-current", "page");
});

test("owner listing management is distinct from browsing the market", async ({ page }) => {
  await page.goto("/portfolio/orders");
  await expect(page.getByRole("heading", { name: "Manage your listings" })).toBeVisible();
  await expect(page.getByText("Buy listed assets here.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available tokens" })).toHaveCount(0);
  await expect(page.locator(".marketplace-market-summary strong")).toHaveText(["—", "—"]);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
});

test("skip link moves keyboard focus past navigation", async ({ page }) => {
  await page.goto("/my-assets");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("legacy screens redirect and placeholder footer actions are gone", async ({ page }) => {
  await page.goto("/liquidate");
  await expect(page).toHaveURL(/\/my-assets$/);
  await expect(page.getByText("Seaport Warehouse 04")).toHaveCount(0);
  await page.goto("/reserves");
  await expect(page).toHaveURL(/\/portfolio\/reserves$/);
  await page.goto("/marketplace");
  await expect(page.locator('footer a[href="#"]')).toHaveCount(0);
  await expect(page.locator("footer").getByRole("link", { name: "Protocol status" })).toHaveAttribute("href", "/protocol");
});

test("provider failures remain actionable in the header", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "cardano", { value: { eternl: { isEnabled: async () => false, enable: async () => ({ getNetworkId: async () => 0 }) } } });
  });
  await page.goto("/my-assets");
  await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
  await expect(page.locator("header").getByRole("alert")).toContainText("HTTP 503");
  await expect(page.locator("header").getByRole("alert")).not.toContainText("BigInt");
});

async function mockWallet(page: Page, key = "ab".repeat(28)) {
  const addressHex = "60" + key;
  await page.route("**/api/blockfrost/epochs/latest/parameters", route => route.fulfill({ json: {
    protocol_major_ver: 10, protocol_minor_ver: 0, min_fee_a: 44, min_fee_b: 155381, max_tx_size: 16384, max_val_size: 5000,
    key_deposit: "2000000", pool_deposit: "500000000", drep_deposit: "500000000", gov_action_deposit: "1000000000",
    price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", coins_per_utxo_size: "4310",
    collateral_percent: 150, max_collateral_inputs: 3, min_fee_ref_script_cost_per_byte: 15, cost_models_raw: PROTOCOL_PARAMETERS_DEFAULT.costModels,
  } }));
  await page.addInitScript(hex => {
    const state = window as typeof window & { testWalletHex: string };
    state.testWalletHex = hex;
    Object.defineProperty(window, "cardano", { value: { eternl: {
      isEnabled: async () => false,
      enable: async () => ({ getNetworkId: async () => 0, getUsedAddresses: async () => [state.testWalletHex], getUnusedAddresses: async () => [], getChangeAddress: async () => state.testWalletHex, getUtxos: async () => [], getCollateral: async () => [], getBalance: async () => "00", signTx: async () => { throw new Error("Signing is forbidden in this test"); } }),
    } } });
  }, addressHex);
  return CML.Address.from_hex(addressHex).to_bech32();
}

test("connected wallet menu does not disconnect on open and fits mobile", async ({ page }) => {
  const address = await mockWallet(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/my-assets");
  await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
  const wallet = page.locator("summary").filter({ hasText: "Wallet" });
  await expect(wallet).toBeVisible();
  await wallet.click();
  await expect(page.getByText(address, { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.getByRole("link", { name: "Wallet details Address and connection information" })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect wallet", exact: true }).click();
  await expect(page.locator("header").getByRole("button", { name: "Connect Eternl" })).toBeVisible();
});

test("disconnected direct operator URLs stay locked, while owner requests remain available", async ({ page }) => {
  for (const path of ["/team", "/team/dex", "/team/inventory", "/team/controls", "/team/recovery", "/registry", "/wallets"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Connect an operator or Team wallet" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Operations navigation", exact: true })).toHaveCount(0);
    await expect(page.locator(".team-hero, .price-book-panel, .shared-pool-workspace")).toHaveCount(0);
  }
  await page.goto("/portfolio/asset-requests");
  await expect(page.locator(".operator-access-card")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Asset support requests" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manage approved assets" })).toHaveCount(0);
});

test("ordinary wallet cannot enter the operator console", async ({ page }) => {
  await mockWallet(page);
  await page.goto("/team");
  await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
  await expect(page.getByRole("heading", { name: "This wallet does not have operator access" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Operations navigation", exact: true })).toHaveCount(0);
  await page.goto("/portfolio/asset-requests");
  await expect(page.getByRole("heading", { name: "Asset support requests" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manage approved assets" })).toHaveCount(0);
  await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
  await expect(page.getByRole("heading", { name: "Asset support requests" })).toBeVisible();
  await page.goto("/registry");
  await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
  await expect(page.getByRole("heading", { name: "This wallet does not have operator access" })).toBeVisible();
});

test("operator access is enabled only while the authorized wallet remains connected", async ({ page }) => {
  await mockWallet(page, deployment.batcher);
  await page.goto("/team");
  await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
  await expect(page.getByRole("heading", { name: "Shared pool capacity" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Operations navigation", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Operations navigation", exact: true }).getByRole("link", { name: "Team wallet" }).click();
  await expect(page.getByRole("heading", { name: "Team wallet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connected Team account" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Operations navigation", exact: true }).getByRole("link", { name: "Team wallet" })).toBeVisible();
  await page.getByRole("navigation", { name: "Operations navigation", exact: true }).getByRole("link", { name: "Overview & requests" }).click();
  await page.locator("summary").filter({ hasText: "More" }).click();
  await expect(page.getByRole("link", { name: /Operator console Approvals/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    (window as typeof window & { testWalletHex: string }).testWalletHex = "60" + "ab".repeat(28);
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByRole("heading", { name: "This wallet does not have operator access" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shared pool capacity" })).toHaveCount(0);
  await page.locator(".operator-access-card").getByRole("button", { name: "Disconnect wallet" }).click();
  await expect(page.getByRole("heading", { name: "Connect an operator or Team wallet" })).toBeVisible();
});

test("a submitted Marketplace transaction is restored after reload", async ({ page }) => {
  const address = await mockWallet(page, deployment.batcher);
  const hash = "ab".repeat(32);
  await page.goto("/team");
  await page.evaluate(({ address, hash }) => {
    localStorage.setItem("cswap.pending-market.preprod.v1." + address, JSON.stringify({ version: 1, network: "preprod", wallet: address, operation: "instant sell acquisition", hash, submittedAt: Date.now() }));
  }, { address, hash });
  await page.reload();
  await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
  await expect(page.getByText("instant sell acquisition awaiting confirmation.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Inspect submitted transaction" })).toHaveAttribute("href", "https://preprod.cardanoscan.io/transaction/" + hash);
  await page.getByRole("button", { name: "Check confirmation" }).click();
  await expect(page.getByText("Transaction is not confirmed yet.", { exact: false })).toBeVisible();
  await expect(page.getByText("instant sell acquisition awaiting confirmation.")).toBeVisible();
});
