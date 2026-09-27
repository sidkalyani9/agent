import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as service from "./service.js";
import { verifyAccess, passwordProblems } from "./passwords.js";
process.env.SESSION_SECRET = "security-regression-secret-for-temporary-databases";
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pantry-security-"));
  const file = path.join(dir, "test.sqlite");
  const db = await service.openDatabase(file, {
    seed: "production"
  });
  service.setClock(() => new Date("2026-09-25T06:00:00Z"));
  t.after(async () => {
    service.setClock();
    await db.close();
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  });
  const admin = (await service.signIn(db, "Siddharth.Kalyani@intuitive.AI")).person;
  const member = await service.saveAccess(db, admin, {
    signInName: "member@intuitive.AI",
    displayName: "Member",
    role: "admin"
  });
  return {
    db,
    admin,
    member,
    file
  };
}
test("disabled then re-enabled accounts cannot reuse old sessions or setup tickets", async t => {
  const {
    db,
    admin,
    member
  } = await fixture(t);
  const session = await service.beginBrowserSession(db, member.id);
  const invite = await service.invitePerson(db, admin, {
    email: member.email
  });
  const setup = await service.loginWithPassword(db, invite.email, invite.temporaryPassword);
  await service.setPersonActive(db, admin, member.id, false);
  await service.setPersonActive(db, admin, member.id, true);
  assert.equal(await service.personFromAccessToken(db, session.accessToken), null);
  await assert.rejects(async () => await service.rotateRefresh(db, session.refreshToken), {
    status: 401
  });
  assert.equal(await service.setupContext(db, setup.setupToken), null);
});
test("replacing an invite invalidates the previous setup ticket", async t => {
  const {
    db,
    admin,
    member
  } = await fixture(t);
  const first = await service.invitePerson(db, admin, {
    email: member.email
  });
  const setup = await service.loginWithPassword(db, first.email, first.temporaryPassword);
  await service.invitePerson(db, admin, {
    email: member.email
  });
  await assert.rejects(async () => await service.completePasswordSetup(db, setup.setupToken, "New secure code 42", "New secure code 42"), {
    status: 401
  });
});
test("inactive super admins do not allow disabling the final active super admin", async t => {
  const {
    db,
    admin
  } = await fixture(t);
  const second = await service.saveAccess(db, admin, {
    signInName: "second@intuitive.AI",
    displayName: "Second",
    role: "super_admin"
  });
  await service.setPersonActive(db, admin, second.id, false);
  await assert.rejects(async () => await service.setPersonActive(db, admin, admin.id, false), {
    status: 422
  });
  await assert.rejects(async () => await service.removeGrant(db, admin, admin.id, admin.grants[0].id), {
    status: 422
  });
});
test("restarting does not restore a revoked bootstrap super-admin role", async t => {
  const {
    db,
    admin,
    file
  } = await fixture(t);
  const second = await service.saveAccess(db, admin, {
    signInName: "second@intuitive.AI",
    displayName: "Second",
    role: "super_admin"
  });
  const actor = (await service.signIn(db, second.email)).person;
  await service.removeGrant(db, actor, admin.id, admin.grants[0].id);
  const reopened = await service.openDatabase(file, {
    seed: "production"
  });
  try {
    assert.equal((await service.signIn(reopened, admin.email)).person.superAdmin, false);
  } finally {
    reopened.close();
  }
});
test("refresh preserves the family CSRF token and permits a return after a month", async t => {
  const {
    db,
    member
  } = await fixture(t);
  const first = await service.beginBrowserSession(db, member.id);
  service.setClock(() => new Date("2026-11-01T06:00:00Z"));
  const next = await service.rotateRefresh(db, first.refreshToken);
  assert.equal(next.csrf, first.csrf);
  assert.notEqual(next.refreshToken, first.refreshToken);
  const row = await db.prepare("SELECT * FROM refresh_token WHERE id = ?").get(next.refreshId);
  assert.equal(row.absolute_expires_at, "2027-03-24T06:00:00.000Z");
  assert.equal(row.expires_at, "2027-01-30T06:00:00.000Z");
});
test("CSV text cells cannot become spreadsheet formulas", async t => {
  const {
    db,
    admin
  } = await fixture(t);
  const office = await service.createOffice(db, admin, "One");
  const product = await service.createProduct(db, admin, office.id, '=HYPERLINK("https://example.invalid","Open")');
  await service.createPurchase(db, admin, office.id, {
    productId: product.productId,
    date: "2026-09-20",
    packs: 1,
    pricePerPack: "10.00"
  });
  const csv = (await service.exportCsv(db, admin, office.id, "2026-09")).body;
  assert.match(csv, /"'=HYPERLINK/);
});
test("impossible dates, invalid months, unsafe amounts and oversized names are rejected", async t => {
  const {
    db,
    admin
  } = await fixture(t);
  const office = await service.createOffice(db, admin, "One");
  const product = await service.createProduct(db, admin, office.id, "Biscuits");
  const purchase = {
    productId: product.productId,
    date: "2026-09-20",
    packs: 1,
    pricePerPack: "10.00"
  };
  for (const date of ["2026-02-30", "2026-00-10", "0000-01-01"]) {
    await assert.rejects(async () => await service.createPurchase(db, admin, office.id, {
      ...purchase,
      date
    }), {
      status: 422
    });
  }
  await assert.rejects(async () => await service.getPantry(db, admin, office.id, "2026-13"), {
    status: 422
  });
  await assert.rejects(async () => await service.createPurchase(db, admin, office.id, {
    ...purchase,
    packs: 1e99
  }), {
    status: 422
  });
  await assert.rejects(async () => await service.createPurchase(db, admin, office.id, {
    ...purchase,
    pricePerPack: 1e99
  }), {
    status: 422
  });
  await assert.rejects(async () => await service.createProduct(db, admin, office.id, "X".repeat(121)), {
    status: 422
  });
});
test("password failures do not disclose whether an email was invited", async t => {
  const {
    db,
    admin,
    member
  } = await fixture(t);
  await service.invitePerson(db, admin, {
    email: member.email
  });
  let known, unknown;
  try {
    await service.loginWithPassword(db, member.email, "Wrong password 42");
  } catch (error) {
    known = error;
  }
  try {
    await service.loginWithPassword(db, "unknown@intuitive.AI", "Wrong password 42");
  } catch (error) {
    unknown = error;
  }
  assert.equal(known.status, unknown.status);
  assert.equal(known.message, unknown.message);
});

test("a role removed while a request is in flight cannot still authorize a write", async t => {
  const { db, admin } = await fixture(t);
  const office = await service.createOffice(db, admin, "One");
  const granted = await service.saveAccess(db, admin, { signInName: "writer@intuitive.AI", displayName: "Writer", role: "office_manager", officeId: office.id });
  const stale = (await service.signIn(db, granted.email)).person;
  await service.removeGrant(db, admin, granted.id, granted.grants[0].id);
  await assert.rejects(service.createProduct(db, stale, office.id, "Not permitted"), { status: 404 });
});

test("refresh ends at 90 idle days or the original 180-day absolute cap", async t => {
  const { db, member } = await fixture(t);
  const start = Date.parse("2026-09-25T06:00:00Z");
  const atDay = n => service.setClock(() => new Date(start + n * 86400000));
  const idle = await service.beginBrowserSession(db, member.id);
  atDay(90);
  await assert.rejects(service.rotateRefresh(db, idle.refreshToken), { status: 401 });
  atDay(0);
  let session = await service.beginBrowserSession(db, member.id);
  for (const day of [60, 120, 179]) { atDay(day); session = await service.rotateRefresh(db, session.refreshToken); }
  assert.equal(session.refreshMaxAge, 86400);
  atDay(180);
  await assert.rejects(service.rotateRefresh(db, session.refreshToken), { status: 401 });
});

test("malformed JWT headers are rejected and common-password suffixes are not accepted", () => {
  assert.equal(verifyAccess(`${Buffer.from("null").toString("base64url")}.e30.invalid`), null);
  assert.ok(passwordProblems("Password123456!", "member@intuitive.AI").length);
});
