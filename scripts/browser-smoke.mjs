import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startTestApp } from "../server/test-app.js";

const app = await startTestApp({ port: 5173 });
const browser = await chromium.launch({ ...(process.env.PANTRY_BROWSER_CHANNEL ? { channel: process.env.PANTRY_BROWSER_CHANNEL } : {}) });
try {
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
  for (const label of ["Charts", "Activity", "Access", "Stock"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("main.page")).toBeVisible();
  }
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
  await mobile.getByRole("button", { name: "Log out" }).click();
  await expect(mobile.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await mobile.reload();
  await expect(mobile.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: login, product edit, receipt download, shared screens, theme, two-tab refresh, persistent cookies, 390px layout, logout.");
  await returning.close();
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(os.tmpdir(), "pantry-browser-failure.png") });
    console.error(await page.locator("main").innerText());
  }
  throw error;
} finally { await browser.close(); await app.close(); }
