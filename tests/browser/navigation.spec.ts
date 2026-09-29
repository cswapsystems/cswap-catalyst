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

test("asset links load the requested metadata and attestation", async ({ page }) => {
  const asset = "a".repeat(56) + "74657374";
  const imageCid = "QmYwAPJzv5CZsnAzt8auVTL7rZ3pUqC4hY4oF5nYhYy2PP";
  const proofCid = "QmYwAPJzv5CZsnAzt8auVTL7rZ3pUqC4hY4oF5nYhYy2PP";
  await page.route(`**/api/blockfrost/assets/${asset}*`, route => {
    if (route.request().url().endsWith("/metadata")) return route.fulfill({ json: {} });
    return route.fulfill({ json: {
      asset, policy_id: "a".repeat(56), asset_name: "74657374",
      onchain_metadata: { name: "Test RWA", image: `ipfs://${imageCid}`, files: [{ name: "Proof of authenticity", mediaType: "application/pdf", src: `ipfs://${proofCid}` }] },
    } });
  });
  await page.goto(`/assets?asset=${asset}`);
  await expect(page.getByRole("textbox", { name: "Asset ID" })).toHaveValue(asset);
  await expect(page.getByRole("heading", { name: "Test RWA" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Proof of authenticity/ })).toHaveAttribute("href", `/api/ipfs/gateway/${proofCid}`);
  await expect(page.getByRole("link", { name: /Asset image/ })).toHaveAttribute("href", `/api/ipfs/gateway/${imageCid}`);
  await expect(page.getByRole("img", { name: "Test RWA" })).toHaveAttribute("src", `/api/ipfs/gateway/${imageCid}`);
  await expect.poll(() => page.evaluate((unit) => localStorage.getItem("cswap.asset-name.preprod.v1." + unit), asset)).toBe("Test RWA");
});

test("Portfolio uses the metadata name and retains it when the provider is unavailable", async ({ page }) => {
  const key = "ab".repeat(28);
  const policy = "70b2cb1d67a1cd4eac3a92281524cd027a0685407d77e54132d1dd5c";
  const token = "DEMO-COL-01";
  const tokenHex = Buffer.from(token).toString("hex");
  const unit = policy + tokenHex;
  const assets = CML.MultiAsset.new();
  assets.set(CML.ScriptHash.from_hex(policy), CML.AssetName.from_str(token), BigInt(1));
  const input = CML.TransactionInput.new(CML.TransactionHash.from_hex("ac".repeat(32)), BigInt(0));
  const output = CML.TransactionOutput.new(CML.Address.from_hex("60" + key), CML.Value.new(BigInt(5_000_000), assets));
  await mockWallet(page, key, [CML.TransactionUnspentOutput.new(input, output).to_cbor_hex()]);
  let providerAvailable = true;
  await page.route(`**/api/blockfrost/assets/${unit}`, route => providerAvailable
    ? route.fulfill({ json: { onchain_metadata: { name: "Preprod Demo Spiral Canvas" } } })
    : route.fulfill({ status: 503, json: { error: "Offline" } }));
  await page.goto("/my-assets");
  await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
  await expect(page.getByRole("heading", { name: "Preprod Demo Spiral Canvas" })).toBeVisible();
  providerAvailable = false;
  await page.reload();
  const connectButton = page.locator("header").getByRole("button", { name: "Connect Eternl" });
  if (await connectButton.isVisible()) await connectButton.click();
  await expect(page.getByRole("heading", { name: "Preprod Demo Spiral Canvas" })).toBeVisible();
});

test("disconnected Marketplace and Swap provide readable next steps", async ({ page }) => {
  const contrast = async (selector: string) => page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (value: string) => rgb(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  await page.goto("/marketplace");
  await expect(page.locator(".marketplace-toolbar-actions").getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.locator(".marketplace-refresh")).toBeDisabled();
  expect(await contrast(".marketplace-refresh")).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(".marketplace-empty")).toBeGreaterThanOrEqual(4.5);
  await page.goto("/dex");
  await expect(page.locator(".swap-submit").getByRole("button", { name: "Connect wallet" })).toBeEnabled();
  expect(await contrast(".dex-empty")).toBeGreaterThanOrEqual(4.5);
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

async function mockWallet(page: Page, key = "ab".repeat(28), utxos: string[] = []) {
  const addressHex = "60" + key;
  await page.route("**/api/blockfrost/epochs/latest/parameters", route => route.fulfill({ json: {
    protocol_major_ver: 10, protocol_minor_ver: 0, min_fee_a: 44, min_fee_b: 155381, max_tx_size: 16384, max_val_size: 5000,
    key_deposit: "2000000", pool_deposit: "500000000", drep_deposit: "500000000", gov_action_deposit: "1000000000",
    price_mem: 0.0577, price_step: 0.0000721, max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000", coins_per_utxo_size: "4310",
    collateral_percent: 150, max_collateral_inputs: 3, min_fee_ref_script_cost_per_byte: 15, cost_models_raw: PROTOCOL_PARAMETERS_DEFAULT.costModels,
  } }));
  await page.addInitScript(({ hex, utxos }) => {
    const state = window as typeof window & { testWalletHex: string; testWalletUtxos: string[] };
    state.testWalletHex = hex;
    state.testWalletUtxos = utxos;
    Object.defineProperty(window, "cardano", { value: { eternl: {
      isEnabled: async () => false,
      enable: async () => ({ getNetworkId: async () => 0, getUsedAddresses: async () => [state.testWalletHex], getUnusedAddresses: async () => [], getChangeAddress: async () => state.testWalletHex, getUtxos: async () => state.testWalletUtxos, getCollateral: async () => [], getBalance: async () => "00", signTx: async () => { throw new Error("Signing is forbidden in this test"); } }),
    } } });
  }, { hex: addressHex, utxos });
  return CML.Address.from_hex(addressHex).to_bech32();
}

test("Instant Sell dialog keeps long asset IDs and pool references inside its scroll area", async ({ page }) => {
  const key = "ab".repeat(28);
  const policy = "70b2cb1d67a1cd4eac3a92281524cd027a0685407d77e54132d1dd5c";
  const assets = CML.MultiAsset.new();
  assets.set(CML.ScriptHash.from_hex(policy), CML.AssetName.from_str("RWA-DEMO-VERY-LONG-NAME-00000001"), BigInt(1));
  const input = CML.TransactionInput.new(CML.TransactionHash.from_hex("aa".repeat(32)), BigInt(0));
  const output = CML.TransactionOutput.new(CML.Address.from_hex("60" + key), CML.Value.new(BigInt(5_000_000), assets));
  const utxo = CML.TransactionUnspentOutput.new(input, output).to_cbor_hex();
  await mockWallet(page, key, [utxo]);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 680 });
    await page.goto("/my-assets");
    await page.locator("header").getByRole("button", { name: "Connect Eternl" }).click();
    await page.getByRole("button", { name: "Sell / List" }).first().click();
    const dialog = page.getByRole("dialog", { name: /Sell RWA-DEMO-VERY-LONG-NAME/ });
    await dialog.getByRole("button", { name: "Request Instant Sell" }).click();
    await expect(dialog.getByRole("button", { name: "Request Instant Sell" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByText("Quote unavailable")).toBeVisible();
    await dialog.locator(".execution-preview").evaluate((preview) => {
      const line = document.createElement("p");
      line.textContent = "Pool snapshot: ";
      const code = document.createElement("code");
      code.textContent = "ab".repeat(32) + "#0";
      line.append(code);
      preview.prepend(line);
    });
    const metrics = await dialog.evaluate((element) => {
      const code = element.querySelector(".execution-preview code")!;
      const dialogRect = element.getBoundingClientRect();
      const codeRect = code.getBoundingClientRect();
      return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, left: codeRect.left, right: codeRect.right, dialogLeft: dialogRect.left, dialogRight: dialogRect.right };
    });
    expect(metrics.scrollWidth, `dialog overflow at ${width}px`).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.left).toBeGreaterThanOrEqual(metrics.dialogLeft);
    expect(metrics.right).toBeLessThanOrEqual(metrics.dialogRight);
    await dialog.getByRole("button", { name: "Close sale" }).click();
  }
});

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
