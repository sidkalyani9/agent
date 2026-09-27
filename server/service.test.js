process.env.PANTRY_SEED = "fixtures";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HttpError, confirmProposal, createProposal, createProduct, getPantry, acceptMicrosoftLogin, assignOfficeManager, createOffice, createPurchase, hideProduct, listOffices, openDatabase, removeGrant, saveAccess, setClock, signIn, summary } from "./service.js";
test("seeded pantry keeps who entered a line, and the assistant cannot hide", async () => {
  setClock(() => new Date("2026-09-25T06:00:00.000Z"));
  const file = path.join(os.tmpdir(), `aim-${Date.now()}.sqlite`);
  const db = await openDatabase(file);
  const meera = (await signIn(db, "meera.patel@intuitive.AI")).person;
  const isha = (await signIn(db, "isha.rao@intuitive.AI")).person;
  const avery = (await signIn(db, "avery.shah@intuitive.AI")).person;
  const offices = (await summary(db, avery, "2026-09")).offices;
  const ahmedabad = offices.find(office => office.name === "Ahmedabad");
  const pantry = await getPantry(db, meera, ahmedabad.officeId, "2026-09");
  const coffee = pantry.products.find(product => product.name === "Coffee");
  const milk = pantry.products.find(product => product.name === "Milk");
  assert.equal(coffee.createdBy, "Avery Shah");
  assert.equal(coffee.status === "not_enough_history", false);
  assert.ok(coffee.burnRatePerEffectiveDay);
  assert.ok(coffee.series.some(point => point.date === "2026-09-25" && point.onHand === coffee.onHand));
  assert.ok(milk.burnRatePerEffectiveDay);
  assert.ok(milk.history.some(month => month.month === "2026-07" && month.packs > 0));
  assert.ok(milk.history.some(month => month.month === "2026-08" && month.packs > 0));
  assert.ok(milk.forecast.packs);
  assert.ok(pantry.forecast.spend);
  const pune = offices.find(office => office.name === "Pune");
  assert.ok(pune.forecastSpend);
  await assert.rejects(async () => await getPantry(db, meera, offices.find(office => office.name === "Pune").officeId, "2026-09"), error => error.status === 404);
  await assert.rejects(async () => await createProduct(db, isha, ahmedabad.officeId, "Biscuits"), error => error.status === 403);
  await assert.rejects(async () => await signIn(db, "guest@gmail.com"), error => error instanceof HttpError);
  await assert.rejects(async () => await createProposal(db, meera, "hide_product", {
    office: "Ahmedabad"
  }), error => error.status === 403);
  const proposal = await createProposal(db, meera, "create_product", {
    office: "Ahmedabad",
    name: "Biscuits"
  });
  const saved = await confirmProposal(db, meera, proposal.proposalId);
  assert.equal(saved.ok, true);
  const again = await getPantry(db, meera, ahmedabad.officeId, "2026-09");
  const biscuits = again.products.find(product => product.name === "Biscuits");
  assert.equal(biscuits.createdBy, "Meera Patel");
  await hideProduct(db, meera, coffee.productId);
  const august = await getPantry(db, meera, ahmedabad.officeId, "2026-08");
  assert.ok(august.products.some(product => product.name === "Coffee" && product.deletedAt));
  await db.close();
  fs.rmSync(file, {
    force: true
  });
});
test("admin sees every office, and only a super admin can add an office or name its manager", async () => {
  setClock(() => new Date("2026-09-25T06:00:00.000Z"));
  const file = path.join(os.tmpdir(), `aim-offices-${Date.now()}.sqlite`);
  const db = await openDatabase(file);
  const isha = (await signIn(db, "isha.rao@intuitive.AI")).person;
  const avery = (await signIn(db, "avery.shah@intuitive.AI")).person;
  const kabir = (await signIn(db, "kabir.mehta@intuitive.AI")).person;
  const meera = (await signIn(db, "meera.patel@intuitive.AI")).person;
  assert.equal(isha.seesEveryOffice, true);
  assert.equal(isha.admin, true);
  assert.equal((await listOffices(db, isha)).map(office => office.name).join(","), "Ahmedabad,Pune");
  const pune = (await listOffices(db, isha)).find(office => office.name === "Pune");
  assert.equal((await getPantry(db, isha, pune.id, "2026-09")).canWrite, false);
  assert.equal((await summary(db, isha, "2026-09")).offices.length, 2);
  await assert.rejects(async () => await createOffice(db, isha, "Surat"), error => error.status === 403);
  await assert.rejects(async () => await assignOfficeManager(db, isha, pune.id, kabir.id), error => error.status === 403);
  await assert.rejects(async () => await summary(db, kabir, "2026-09"), error => error.status === 403);
  assert.equal((await listOffices(db, kabir)).length, 2);
  const surat = await createOffice(db, avery, "Surat", kabir.id);
  assert.equal(surat.managerName, "Kabir Mehta");
  const kabirAgain = (await signIn(db, "kabir.mehta@intuitive.AI")).person;
  assert.equal((await getPantry(db, kabirAgain, surat.id, "2026-09")).canWrite, true);
  assert.ok((await listOffices(db, kabirAgain)).some(office => office.name === "Surat"));
  assert.equal((await listOffices(db, meera)).some(office => office.name === "Surat"), false);
  await assert.rejects(async () => await assignOfficeManager(db, avery, surat.id, kabir.id), error => error.status === 422);
  await db.close();
  fs.rmSync(file, {
    force: true
  });
});
test("a receipt that is not a PDF, JPEG, or PNG leaves the purchase saved", async () => {
  setClock(() => new Date("2026-09-25T06:00:00.000Z"));
  const file = path.join(os.tmpdir(), `aim-receipt-${Date.now()}.sqlite`);
  const db = await openDatabase(file);
  try {
    const meera = (await signIn(db, "meera.patel@intuitive.AI")).person;
    const officeId = (await db.prepare("SELECT id FROM office WHERE name = 'Ahmedabad'").get()).id;
    const productId = (await db.prepare("SELECT id FROM pantry_product WHERE office_id = ? AND name = 'Coffee'").get(officeId)).id;
    const saved = await createPurchase(db, meera, officeId, {
      productId,
      date: "2026-09-21",
      packs: 1,
      pricePerPack: "10.00"
    }, {
      fileName: "note.html",
      contentType: "text/html",
      bytes: Buffer.from("<html></html>")
    });
    assert.equal(saved.receiptSaved, false);
    assert.match(saved.receiptError, /PDF, JPEG, or PNG/);
    const row = await db.prepare("SELECT id FROM pantry_purchase WHERE id = ?").get(saved.purchaseId);
    assert.ok(row);
  } finally {
    await db.close();
    fs.rmSync(file, {
      force: true
    });
    fs.rmSync(`${file}-wal`, {
      force: true
    });
    fs.rmSync(`${file}-shm`, {
      force: true
    });
  }
});
test("a fresh pantry admits only the seeded super admin and people that admin adds", async () => {
  const file = path.join(os.tmpdir(), `aim-prod-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  const previousEmail = process.env.SEED_SUPERADMIN_EMAIL;
  const previousName = process.env.SEED_SUPERADMIN_NAME;
  const previousOid = process.env.SEED_SUPERADMIN_OBJECT_ID;
  process.env.SEED_SUPERADMIN_EMAIL = "Siddharth.Kalyani@intuitive.AI";
  process.env.SEED_SUPERADMIN_NAME = "Siddharth Kalyani";
  delete process.env.SEED_SUPERADMIN_OBJECT_ID;
  const db = await openDatabase(file, {
    seed: "production"
  });
  try {
    const names = (await db.prepare("SELECT sign_in_name FROM person").all()).map(row => row.sign_in_name);
    assert.deepEqual(names, ["Siddharth.Kalyani@intuitive.AI"]);
    assert.equal((await db.prepare("SELECT id FROM office").all()).length, 0);
    const siddharth = (await signIn(db, "siddharth.kalyani@intuitive.ai")).person;
    assert.equal(siddharth.superAdmin, true);
    assert.equal(siddharth.displayName, "Siddharth Kalyani");
    await assert.rejects(async () => await acceptMicrosoftLogin(db, {
      oid: "11111111-1111-4111-8111-111111111111",
      signInName: "other.person@intuitive.AI",
      displayName: "Other Person"
    }), error => error.status === 403 && error.code === "not_on_list");
    await assert.rejects(async () => await acceptMicrosoftLogin(db, {
      oid: "11111111-1111-4111-8111-111111111111",
      signInName: "guest@gmail.com",
      displayName: "Guest"
    }), error => error.code === "domain");
    const bound = await acceptMicrosoftLogin(db, {
      oid: "11111111-1111-4111-8111-111111111111",
      signInName: "Siddharth.Kalyani@intuitive.AI",
      displayName: "Siddharth Kalyani"
    });
    assert.equal(bound.superAdmin, true);
    await assert.rejects(async () => await acceptMicrosoftLogin(db, {
      oid: "22222222-2222-4222-8222-222222222222",
      signInName: "Siddharth.Kalyani@intuitive.AI",
      displayName: "Siddharth Kalyani"
    }), error => error.code === "not_on_list");
    await assert.rejects(async () => await saveAccess(db, siddharth, {
      signInName: "outsider@gmail.com",
      displayName: "Outsider",
      role: "admin"
    }), error => error.status === 422);
    const added = await saveAccess(db, siddharth, {
      signInName: "meera.patel@intuitive.AI",
      displayName: "Meera Patel",
      role: "admin"
    });
    assert.equal(added.grants[0].role, "admin");
    assert.equal(added.grants[0].officeId, null);
    const meera = (await signIn(db, "meera.patel@intuitive.AI")).person;
    assert.equal(meera.seesEveryOffice, true);
    assert.equal(meera.superAdmin, false);
    await assert.rejects(async () => await saveAccess(db, meera, {
      signInName: "isha.rao@intuitive.AI",
      displayName: "Isha Rao",
      role: "accounts",
      officeId: "missing"
    }), error => error.status === 403);
    const superGrant = siddharth.grants.find(grant => grant.role === "super_admin");
    await assert.rejects(async () => await removeGrant(db, bound, siddharth.id, superGrant.id), error => error.status === 422);
    assert.equal((await removeGrant(db, bound, added.id, added.grants[0].id)).removed, true);
  } finally {
    await db.close();
    fs.rmSync(file, {
      force: true
    });
    fs.rmSync(`${file}-wal`, {
      force: true
    });
    fs.rmSync(`${file}-shm`, {
      force: true
    });
    if (previousEmail === undefined) delete process.env.SEED_SUPERADMIN_EMAIL;else process.env.SEED_SUPERADMIN_EMAIL = previousEmail;
    if (previousName === undefined) delete process.env.SEED_SUPERADMIN_NAME;else process.env.SEED_SUPERADMIN_NAME = previousName;
    if (previousOid === undefined) delete process.env.SEED_SUPERADMIN_OBJECT_ID;else process.env.SEED_SUPERADMIN_OBJECT_ID = previousOid;
  }
});
