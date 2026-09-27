import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import * as s from "./service.js";
import { postgresSql } from "./database.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectMigration, migrateSnapshot } from "./migration.js";

process.env.SESSION_SECRET = "postgres-tests-use-only-temporary-data-secret";

// PGlite runs the PostgreSQL engine locally. It exercises PostgreSQL syntax,
// types, uniqueness and transactions; Azure networking/TLS is a staging check.
export async function postgresFixture(t, seed = "production") {
  const engine = new PGlite();
  let tail = Promise.resolve();
  const query = async (sql, params = []) => {
    if (!params.length && sql.includes(";")) return (await engine.exec(sql)).at(-1);
    const result = await engine.query(sql, params);
    return { ...result, rowCount: result.affectedRows };
  };
  const pool = {
    query,
    async connect() {
      const prior = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      await prior;
      return { query, release };
    },
    async end() { await engine.close(); },
  };
  const db = await s.openDatabase("unused", { pool, seed });
  t.after(async () => { s.setClock(); await db.close(); });
  return db;
}

test("PostgreSQL placeholders preserve quoted question marks", () => {
  assert.equal(postgresSql("SELECT '?' AS literal, 'it''s ?' AS quoted WHERE id = ?"), "SELECT '?' AS literal, 'it''s ?' AS quoted WHERE id = $1");
});

test("PostgreSQL supports Phase 1 isolation, writes, exports, roles and sessions", async t => {
  const db = await postgresFixture(t);
  s.setClock(() => new Date("2026-09-25T06:00:00Z"));
  const admin = (await s.signIn(db, "Siddharth.Kalyani@intuitive.AI")).person;
  const one = await s.createOffice(db, admin, "One");
  const two = await s.createOffice(db, admin, "Two");
  await assert.rejects(s.createOffice(db, admin, "ONE"), { status: 422 });
  const assigned = await s.saveAccess(db, admin, { signInName: "manager@intuitive.AI", displayName: "Manager", role: "office_manager", officeId: one.id });
  const manager = (await s.signIn(db, assigned.email)).person;
  await assert.rejects(s.getPantry(db, manager, two.id), { status: 404 });
  const pantry = await s.getPantry(db, manager, one.id, "2026-09");
  assert.equal(pantry.products.length, 5);
  assert.ok(pantry.products.every(p => p.onHand === "0.00" && p.status === "not_enough_history"));
  const productId = pantry.products[0].productId;
  const body = { productId, date: "2026-09-20", packs: 2, pricePerPack: "12.50" };
  const purchase = await s.createPurchase(db, manager, one.id, body, null, "postgres-save-01");
  assert.equal((await s.createPurchase(db, manager, one.id, body, null, "postgres-save-01")).purchaseId, purchase.purchaseId);
  assert.equal((await s.getPantry(db, manager, one.id, "2026-09")).spend, "25.00");
  assert.match((await s.exportCsv(db, manager, one.id, "2026-09")).body, /25.00/);
  await s.upsertCount(db, manager, one.id, { productId, date: "2026-09-25", packs: 8 });
  const proposal = await s.createProposal(db, manager, "create_product", { office: "One", name: "Biscuits" });
  assert.equal((await s.confirmProposal(db, manager, proposal.proposalId)).ok, true);
  await assert.rejects(s.confirmProposal(db, manager, proposal.proposalId), { status: 404 });
  const thread = await s.createChatThread(db, manager);
  await s.addChatMessage(db, manager, thread.id, "user", "first");
  await s.addChatMessage(db, manager, thread.id, "assistant", "second");
  assert.deepEqual((await s.getChatThread(db, manager, thread.id)).messages.map(m => m.content), ["first", "second"]);
  const invitation = await s.invitePerson(db, admin, { email: manager.email });
  const setup = await s.loginWithPassword(db, invitation.email, invitation.temporaryPassword);
  const session = await s.completePasswordSetup(db, setup.setupToken, "Good password 42", "Good password 42");
  const rotated = await s.rotateRefresh(db, session.refreshToken);
  assert.equal(rotated.csrf, session.csrf);
  await assert.rejects(s.rotateRefresh(db, session.refreshToken), { status: 401 });
  await assert.rejects(s.rotateRefresh(db, rotated.refreshToken), { status: 401 });
});

test("PostgreSQL serializes concurrent refresh reuse and revokes the family", async t => {
  const db = await postgresFixture(t);
  const admin = (await s.signIn(db, "Siddharth.Kalyani@intuitive.AI")).person;
  const session = await s.beginBrowserSession(db, admin.id);
  const outcomes = await Promise.allSettled([s.rotateRefresh(db, session.refreshToken), s.rotateRefresh(db, session.refreshToken)]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  const next = outcomes.find(r => r.status === "fulfilled").value;
  await assert.rejects(s.rotateRefresh(db, next.refreshToken), { status: 401 });
});

function temporaryReceipts(t, directory) {
  const prior = { PANTRY_DATA_DIR: process.env.PANTRY_DATA_DIR, AZURE_STORAGE_ACCOUNT_URL: process.env.AZURE_STORAGE_ACCOUNT_URL };
  process.env.PANTRY_DATA_DIR = directory;
  delete process.env.AZURE_STORAGE_ACCOUNT_URL;
  t.after(() => { for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value; });
}

test("PostgreSQL receipt audit failure rolls back receipt metadata but keeps the purchase", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pantry-receipt-rollback-"));
  temporaryReceipts(t, directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = await postgresFixture(t);
  const admin = (await s.signIn(db, "Siddharth.Kalyani@intuitive.AI")).person;
  const office = await s.createOffice(db, admin, "One");
  const product = await s.createProduct(db, admin, office.id, "Coffee beans");
  await db.exec("ALTER TABLE operation ADD CONSTRAINT reject_receipt_audit CHECK (action <> 'receipt.attach')");
  const purchase = await s.createPurchase(db, admin, office.id, { productId: product.productId, date: "2026-09-20", packs: 1, pricePerPack: "20" }, { fileName: "receipt.pdf", bytes: Buffer.from("%PDF-1.4\nreceipt\n%%EOF") });
  assert.equal(purchase.receiptSaved, false);
  assert.match(purchase.receiptError, /purchase is saved/);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM pantry_purchase").get()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM pantry_receipt").get()).n, 0);
  await db.exec("ALTER TABLE operation DROP CONSTRAINT reject_receipt_audit");
  assert.equal((await s.attachReceipt(db, admin, purchase.purchaseId, { fileName: "retry.pdf", bytes: Buffer.from("%PDF-1.4\nretry\n%%EOF") })).receiptSaved, true);
});

test("SQLite migration preserves pantry and password data, refuses nonempty targets and omits sessions", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pantry-migration-"));
  temporaryReceipts(t, directory);
  const file = path.join(directory, "source.sqlite");
  const source = await s.openDatabase(file, { seed: "production" });
  t.after(async () => { await source.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const admin = (await s.signIn(source, "Siddharth.Kalyani@intuitive.AI")).person;
  const invite = await s.invitePerson(source, admin, { email: admin.email });
  const setup = await s.loginWithPassword(source, invite.email, invite.temporaryPassword);
  await s.completePasswordSetup(source, setup.setupToken, "Migration safe pass 42", "Migration safe pass 42");
  const office = await s.createOffice(source, admin, "Migration office");
  const product = await s.createProduct(source, admin, office.id, "Biscuits");
  const receiptBytes = Buffer.from("%PDF-1.4\nmigration receipt\n%%EOF");
  await s.createPurchase(source, admin, office.id, { productId: product.productId, date: "2026-09-20", packs: 3, pricePerPack: "12.50" }, { fileName: "migration.pdf", bytes: receiptBytes });
  await s.beginBrowserSession(source, admin.id);
  const snapshot = inspectMigration(file, path.join(directory, "receipts"));
  assert.equal(snapshot.receipts.length, 1);
  assert.deepEqual(snapshot.receipts[0].bytes, receiptBytes);
  assert.match(snapshot.rows.pantry_receipt[0].blob_path, /^legacy-/);
  const target = await postgresFixture(t, "none");
  const broken = { ...snapshot, rows: { ...snapshot.rows, person: [...snapshot.rows.person, snapshot.rows.person[0]] } };
  await assert.rejects(migrateSnapshot(target, broken));
  assert.equal((await target.prepare("SELECT count(*) AS n FROM person").get()).n, 0);
  const uploads = [];
  await migrateSnapshot(target, snapshot, { upload: async receipt => uploads.push(receipt) });
  assert.equal(uploads.length, 1);
  const migrated = (await s.signIn(target, admin.email)).person;
  assert.equal((await s.getPantry(target, migrated, office.id, "2026-09")).spend, "37.50");
  assert.equal((await target.prepare("SELECT count(*) AS n FROM refresh_token").get()).n, 0);
  assert.equal((await s.loginWithPassword(target, admin.email, "Migration safe pass 42")).next, "app");
  await assert.rejects(migrateSnapshot(target, snapshot), /not empty/);
});
