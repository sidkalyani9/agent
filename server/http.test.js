import assert from "node:assert/strict";
import test from "node:test";
import { startTestApp } from "./test-app.js";
import { allowedOrigin, clientIp, writeCookie } from "./http.js";
import { identityFromClaims } from "./identity.js";
import { validateProductionConfig } from "./config.js";

test("production startup refuses missing security settings and unresolved secret references", () => {
  const valid = {
    NODE_ENV: "production", APP_ORIGIN: "https://pantry.example.com", SESSION_SECRET: "temporary-production-config-test-not-a-real-secret-value",
    ENTRA_TENANT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ENTRA_CLIENT_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    SEED_SUPERADMIN_OBJECT_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ENTRA_CLIENT_SECRET: "temporary-test-client-secret",
    ENTRA_REDIRECT_URI: "https://pantry.example.com/api/auth/callback", DATABASE_URL: "postgresql://test:test@localhost/test",
    AZURE_STORAGE_ACCOUNT_URL: "https://teststorage.blob.core.windows.net", PANTRY_SEED: "", TOKENROUTER_API_KEY: "", OPENROUTER_API_KEY: "",
  };
  const prior = Object.fromEntries(Object.keys(valid).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, valid);
    assert.doesNotThrow(validateProductionConfig);
    for (const [key, value] of [
      ["SESSION_SECRET", ""], ["APP_ORIGIN", "http://pantry.example.com"], ["DATABASE_URL", ""],
      ["PANTRY_SEED", "fixtures"], ["AZURE_STORAGE_ACCOUNT_URL", ""], ["SEED_SUPERADMIN_OBJECT_ID", ""],
      ["SESSION_SECRET", "@Microsoft.KeyVault(SecretUri=https://test.vault.azure.net/secrets/session/)"],
    ]) {
      process.env[key] = value;
      assert.throws(validateProductionConfig, undefined, `${key} must fail closed`);
      process.env[key] = valid[key];
    }
  } finally { for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value; }
});

test("production origins, HTTPS cookies, guest identities, and proxy addresses fail closed", () => {
  const old = { NODE_ENV: process.env.NODE_ENV, APP_ORIGIN: process.env.APP_ORIGIN, WEBSITE_SITE_NAME: process.env.WEBSITE_SITE_NAME };
  try {
    process.env.NODE_ENV = "production"; process.env.APP_ORIGIN = "https://pantry.example.com";
    const request = headers => ({ get: key => headers[key], ip: "192.0.2.1" });
    assert.equal(allowedOrigin(request({ origin: "https://pantry.example.com" })), true);
    for (const origin of [undefined, "null", "http://localhost:5173", "https://evil.example"]) assert.equal(allowedOrigin(request({ origin })), false);
    assert.equal(allowedOrigin(request({ origin: "https://pantry.example.com", "sec-fetch-site": "cross-site" })), false);
    let cookie;
    writeCookie({ getHeader: () => null, setHeader: (_, value) => { cookie = value; } }, "aim_refresh", "test", { maxAge: 7776000, path: "/api/auth" });
    assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=7776000; Secure/);
    assert.equal(clientIp(request({ "x-forwarded-for": "spoofed" })), "192.0.2.1");
    process.env.WEBSITE_SITE_NAME = "pantry";
    assert.equal(clientIp(request({ "client-ip": "203.0.113.1:1234", "x-forwarded-for": "spoofed" })), "203.0.113.1");
    const claims = { tid: "tenant", aud: "client", iss: "https://login.microsoftonline.com/tenant/v2.0", oid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", preferred_username: "person@intuitive.AI" };
    const config = { tenantId: "tenant", clientId: "client" };
    assert.equal(identityFromClaims({ ...claims, acct: 1 }, config).ok, false);
    assert.equal(identityFromClaims(claims, config).ok, false);
    assert.equal(identityFromClaims({ ...claims, acct: 0 }, config).ok, true);
    assert.equal(identityFromClaims({ ...claims, acct: 0, preferred_username: undefined, email: "person@intuitive.AI" }, config).ok, false);
  } finally { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; }
});

test("HTTP enforces authentication, CSRF, office roles, receipt access and session revocation", async t => {
  const app = await startTestApp(); t.after(() => app.close());
  const one = app.offices.find(o => o.name === "Ahmedabad").id;
  const two = app.offices.find(o => o.name === "Pune").id;
  const request = (url, { session, method = "GET", body, csrf = session?.csrf, origin = "http://127.0.0.1:5173" } = {}) => fetch(`${app.base}${url}`, { method, headers: {
    Origin: origin, ...(session ? { Cookie: `aim_access=${session.accessToken}; aim_refresh=${session.refreshToken}` } : {}),
    ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...(body ? { "Content-Type": "application/json" } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await request("/api/offices")).status, 401);
  assert.equal((await request("/api/access", { session: app.sessions.manager })).status, 403);
  assert.equal((await request(`/api/offices/${two}/pantry`, { session: app.sessions.manager })).status, 404);
  assert.equal((await request(`/api/offices/${one}/products`, { session: app.sessions.admin, method: "POST", body: { name: "No CSRF" }, csrf: "invalid" })).status, 403);
  assert.equal((await request("/api/auth/refresh", { session: app.sessions.admin, method: "POST", body: {}, origin: "https://evil.example" })).status, 403);
  const pantry = await (await request(`/api/offices/${one}/pantry`, { session: app.sessions.manager })).json();
  const productId = pantry.products[0].productId;
  const edit = `/api/products/${productId}`;
  assert.equal((await request(edit, { session: app.sessions.reader, method: "PATCH", body: { name: "Forbidden" } })).status, 403);
  assert.equal((await request(edit, { session: app.sessions.manager, method: "PATCH", body: { name: "Edited coffee", reorderLevel: 2, warningEffectiveDays: 7 } })).status, 200);
  const bytes = Buffer.from("%PDF-1.4\nlocal receipt test\n%%EOF");
  const purchase = await (await request(`/api/offices/${one}/purchases`, { session: app.sessions.manager, method: "POST", body: {
    productId, date: "2026-09-20", packs: 2, pricePerPack: "12.50", receipt: { fileName: "receipt.pdf", dataBase64: bytes.toString("base64") },
  } })).json();
  assert.equal(purchase.receiptSaved, true);
  const receipt = await request(`/api/purchases/${purchase.purchaseId}/receipt`, { session: app.sessions.reader });
  assert.equal(receipt.status, 200); assert.match(receipt.headers.get("content-disposition"), /^attachment/);
  assert.deepEqual(Buffer.from(await receipt.arrayBuffer()), bytes);
  assert.equal((await request(`/api/purchases/${purchase.purchaseId}/receipt`)).status, 401);
  const listed = await (await request(`/api/offices/${one}/purchases?month=2026-09`, { session: app.sessions.reader })).json();
  assert.ok(listed.purchases.some(p => p.purchaseId === purchase.purchaseId && p.receiptName === "receipt.pdf"));
  const invalid = await (await request(`/api/offices/${one}/purchases`, { session: app.sessions.manager, method: "POST", body: {
    productId, date: "2026-09-20", packs: 1, pricePerPack: "10", receipt: { fileName: "bad.html", dataBase64: Buffer.from("<script>bad</script>").toString("base64") },
  } })).json();
  assert.ok(invalid.purchaseId); assert.equal(invalid.receiptSaved, false);
  const refreshed = await request("/api/auth/refresh", { session: app.sessions.admin, method: "POST", body: {} });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.headers.getSetCookie().some(c => c.includes("aim_refresh=") && c.includes("Max-Age=7776000")));
  const me = await request("/api/me", { session: app.sessions.admin });
  assert.equal(me.status, 401);
  const replay = await request("/api/auth/refresh", { session: app.sessions.admin, method: "POST", body: {} });
  assert.equal(replay.status, 401);
  assert.equal((await request("/.env")).headers.get("content-type")?.includes("text/plain"), false);
  const html = await request("/");
  assert.match(html.headers.get("content-security-policy"), /script-src 'self'/);
});
