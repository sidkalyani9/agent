import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { extendedWorkflows } from "./workflows.mjs";
import { startTestApp } from "./test-app.mjs";

const app = await startTestApp();
let browser;
try {
  browser = await chromium.launch({ ...(process.env.PANTRY_BROWSER_CHANNEL ? { channel: process.env.PANTRY_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && /Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
  await page.goto(app.base);
  await page.getByLabel("Email", { exact: true }).fill(app.admin.email);
  await page.getByLabel("Password", { exact: true }).fill(app.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stock", exact: true })).toBeVisible();
  await page.getByText("Edit Coffee", { exact: true }).click();
  const editor = page.locator(".product-editor[open]");
  await editor.getByLabel("Product name", { exact: true }).fill("Coffee beans");
  await editor.getByLabel("Reorder level (packs)").fill("2");
  await editor.getByLabel("Warning window (effective days)").fill("7");
  await editor.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("heading", { name: "Coffee beans", exact: true })).toBeVisible();
  assert.equal(await page.getByRole("button", { name: /hide|restore/i }).count(), 0);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page.getByRole("button", { name: "Purchase", exact: true }).click();
  await page.locator(".record-form select").selectOption({ label: "Coffee beans" });
  await page.getByLabel("Packs", { exact: true }).fill("3");
  await page.getByLabel("Price per pack (INR)").fill("25.50");
  await page.locator('input[type="file"]').setInputFiles({ name: "browser-receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nBrowser test receipt\n%%EOF") });
  await expect(page.getByText("browser-receipt.pdf", { exact: true })).toBeVisible();
  // A failed read after an acknowledged save must not look like a failed
  // purchase and leave the same form ready to be submitted again.
  await page.route("**/api/offices", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary test outage." }) }));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Packs", { exact: true })).toHaveValue("");
  await expect(page.getByText("Saved, but the screen could not refresh. Reload to see the updated pantry.", { exact: true })).toBeVisible();
  await page.unroute("**/api/offices");
  await page.getByRole("button", { name: "Stock", exact: true }).click();
  await page.getByText("Purchases and receipts", { exact: true }).click();
  const row = page.locator(".purchase-row").filter({ has: page.getByRole("button", { name: "Download receipt" }) }).first();
  const downloaded = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download receipt" }).click();
  assert.equal((await downloaded).suggestedFilename(), "browser-receipt.pdf");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page.getByRole("button", { name: "Receipt", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  });
  await page.getByRole("button", { name: "Read receipt", exact: true }).click();
  await expect(page.getByText("The assistant is not switched on yet. Recording on the pantry screen still works.")).toBeVisible({ timeout: 10000 });
  const catalog = await page.evaluate(async () => {
    const offices = await fetch("/api/offices", { credentials: "same-origin" }).then((response) => response.json());
    const office = offices.offices.find((item) => item.name === "Ahmedabad");
    const pantry = await fetch(`/api/offices/${office.id}/pantry`, { credentials: "same-origin" }).then((response) => response.json());
    return {
      today: pantry.today,
      names: Object.fromEntries(pantry.products.filter((product) => !product.deletedAt).map((product) => [product.productId, product.name])),
    };
  });
  let draft = {
    readingId: "browser-reading",
    status: "ready",
    error: null,
    fileName: "warehouse-receipt-scan-from-the-loading-dock-september-very-long-file-name.png",
    result: {
      date: catalog.today,
      note: "The extracted line amounts do not match the receipt total. Check for missing items, taxes, discounts or charges before adding purchases.",
      lines: [
        { id: "0", printed: "Amul Taaza homogenized milk pouch with a long printed description", productId: "", productName: "", packs: 2, pricePerPack: "30.00", lineTotal: "60.00", note: "No unit rate could be read. Check the quantity; price was calculated from the line amount. Reference ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", matched: false, discarded: false },
        { id: "1", printed: "Mystery item", productId: "", productName: "", packs: 1, pricePerPack: "10.00", matched: false, discarded: false },
      ],
    },
  };
  await page.route("**/api/offices/*/receipt-readings**", async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    if (method === "POST" && url.endsWith("/receipt-readings")) {
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ readingId: draft.readingId, status: "reading" }) });
      return;
    }
    if (method === "GET" && url.endsWith("/receipt-readings/open")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reading: null }) });
      return;
    }
    if (method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) });
      return;
    }
    if (method === "PATCH") {
      const body = request.postDataJSON();
      draft = {
        ...draft,
        status: "ready",
        result: {
          date: body.date,
          note: null,
          lines: body.lines.map((line) => ({
            ...draft.result.lines.find((item) => item.id === line.id),
            ...line,
            productName: catalog.names[line.productId] || "",
            matched: Boolean(line.productId),
            discarded: Boolean(line.discarded),
          })),
        },
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) });
      return;
    }
    if (method === "POST" && url.endsWith("/dismiss")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dismissed: true }) });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Read receipt", exact: true }).click();
  const amul = page.locator(".receipt-line", { hasText: "Amul Taaza" });
  await expect(amul.getByText("Not one of this office's products.")).toBeVisible({ timeout: 10000 });
  await expect(amul.getByText("Printed line amount: ₹60.00", { exact: true })).toBeVisible();
  await expect(amul.getByRole("status")).toContainText("Check the quantity");
  await page.screenshot({ path: path.join(os.tmpdir(), "pantry-receipt-desktop-review.png") });
  assert.equal(await page.locator(".receipt-review select").count(), 0);
  await amul.getByRole("button", { name: "Choose a product" }).click();
  await expect(amul.getByLabel("Search products")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(amul.getByLabel("Search products")).toHaveCount(0);
  await amul.getByRole("button", { name: "Choose a product" }).click();
  await amul.getByLabel("Search products").fill("zzz");
  await expect(amul.getByText("No product matches that search.")).toBeVisible();
  await amul.getByLabel("Search products").fill("mil");
  await amul.getByRole("option", { name: "Milk", exact: true }).click();
  await expect(amul.getByRole("button", { name: "Milk", exact: true })).toBeVisible();
  await expect(amul.getByText("Not one of this office's products.")).toHaveCount(0);
  const mystery = page.locator(".receipt-line", { hasText: "Mystery item" });
  await mystery.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(mystery).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await expect(amul.getByText("Printed line amount: ₹60.00", { exact: true })).toBeVisible();
  const receiptOverflow = await page.locator(".record-card").evaluate((card) => [...card.querySelectorAll("input, button, .note, .card-head > div, .choices")]
    .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
    .map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })));
  assert.deepEqual(receiptOverflow, [], "Receipt controls and review notes must fit the mobile viewport.");
  await page.screenshot({ path: path.join(os.tmpdir(), "pantry-receipt-mobile-review.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Clear this receipt", exact: true }).click();
  await expect(page.getByText("Drop a PDF, JPEG, or PNG, or browse")).toBeVisible();
  await page.unroute("**/api/offices/*/receipt-readings**");
  await page.getByRole("button", { name: "Purchase", exact: true }).click();
  await expect(page.locator(".record-form select")).toBeVisible();
  for (const label of ["Charts", "Activity", "Access", "Stock"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("main.page")).toBeVisible();
  }
  await extendedWorkflows({ page, browser, app });
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: path.join(os.tmpdir(), "pantry-desktop-review.png") });
  const second = await context.newPage(); await second.goto(app.base);
  await expect(second.getByRole("button", { name: "Stock", exact: true })).toBeVisible();
  let refreshes = 0;
  context.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/auth/refresh")) refreshes++; });
  await context.clearCookies({ name: "aim_access" });
  await Promise.all([page.reload(), second.reload()]);
  await expect(page.getByRole("button", { name: "Stock", exact: true })).toBeVisible();
  await expect(second.getByRole("button", { name: "Stock", exact: true })).toBeVisible();
  assert.equal(refreshes, 1, "Two tabs should rotate once, preserving replay detection.");
  const persisted = await context.storageState();
  assert.ok(persisted.cookies.find(c => c.name === "aim_refresh").expires > Date.now() / 1000 + 89 * 86400);
  await context.close();
  const returning = await browser.newContext({ storageState: persisted, viewport: { width: 390, height: 844 } });
  const mobile = await returning.newPage(); await mobile.goto(app.base);
  await expect(mobile.getByRole("heading", { name: "Coffee beans", exact: true })).toBeVisible();
  await mobile.getByText("Edit Coffee beans", { exact: true }).click();
  await expect(mobile.locator(".product-editor[open]").getByLabel("Product name", { exact: true })).toBeVisible();
  await mobile.screenshot({ path: path.join(os.tmpdir(), "pantry-mobile-review.png"), fullPage: true });
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.getByRole("button", { name: "Open menu" }).click();
  await mobile.getByRole("button", { name: "Record", exact: true }).click();
  await mobile.getByRole("button", { name: "Receipt", exact: true }).click();
  await expect(mobile.getByText("The assistant is not switched on yet. Recording on the pantry screen still works.")).toBeVisible({ timeout: 10000 });
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.getByRole("button", { name: "Open menu" }).click();
  await mobile.getByRole("button", { name: "Log out" }).click();
  await expect(mobile.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await mobile.reload();
  await expect(mobile.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: login, product edit, receipt download, receipt reading, unmatched lines, offices, settings, CSV, chat, invites, password setup, live role removal, read-only roles, shared screens, theme, two-tab refresh, persistent cookies, 390px layout, logout.");
  await returning.close();
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.locator('.invite-secret code').evaluateAll(nodes => {
      for (const node of nodes) node.textContent = '[redacted test invite]';
    });
    await page.screenshot({ path: path.join(os.tmpdir(), "pantry-browser-failure.png") });
    console.error(await page.locator("main").innerText());
  }
  throw error;
} finally { await browser?.close(); await app.close(); }
