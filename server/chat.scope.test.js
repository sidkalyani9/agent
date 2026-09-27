process.env.PANTRY_SEED = "fixtures";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { converse, factualReply, scopeReply } from "./chat.js";
import { projectRunOut } from "./calc.js";
import { createProposal, getPantry, openDatabase, setClock, signIn } from "./service.js";
test("hide and a wipe are refused, and one product delete is not", () => {
  assert.equal(scopeReply("delete the coffee product"), "");
  assert.match(scopeReply("please hide sugar"), /cannot hide/i);
  assert.match(scopeReply("delete everything"), /one pantry item/i);
  assert.match(scopeReply("remove the receipt"), /cannot remove a receipt/i);
});
test("the weather is out of scope and a pantry follow-up is not", () => {
  assert.match(scopeReply("what is the weather in Ahmedabad"), /only answer questions about this pantry/i);
  assert.equal(scopeReply("how much coffee is left?"), "");
  assert.equal(scopeReply("when is it going to run out?"), "");
});
test("coffee on hand and the run-out date come from the pantry, including a follow-up", async () => {
  setClock(() => new Date("2026-09-25T06:00:00.000Z"));
  const file = path.join(os.tmpdir(), `aim-chat-${Date.now()}.sqlite`);
  const db = await openDatabase(file);
  const meera = (await signIn(db, "meera.patel@intuitive.AI")).person;
  const officeId = (await db.prepare("SELECT id FROM office WHERE name = 'Ahmedabad'").get()).id;
  const office = await getPantry(db, meera, officeId, "2026-09");
  const coffee = office.products.find(product => product.name === "Coffee");
  const first = await factualReply(db, meera, "how much coffee is left and when will it run out?", []);
  assert.match(first, new RegExp(coffee.onHand));
  assert.match(first, /September 2026/);
  const second = await factualReply(db, meera, "when is it going to run out?", [{
    role: "user",
    content: "how much coffee is left"
  }, {
    role: "assistant",
    content: first
  }]);
  assert.match(second, /Coffee at Ahmedabad/);
  assert.match(second, /expected to run out/);
  const screen = coffee.expectedDate;
  const five = await factualReply(db, meera, "office will be shut for 5 more working days, give updated date when it will run out", [{
    role: "user",
    content: "how much coffee is left"
  }, {
    role: "assistant",
    content: first
  }]);
  const twenty = await factualReply(db, meera, "office will be shut for 20 more working days, now when will it run out give updated date", [{
    role: "user",
    content: "how much coffee is left"
  }, {
    role: "assistant",
    content: first
  }]);
  assert.match(five, /shut for 5 more working days/);
  assert.match(five, /pantry screen stays/);
  const fiveDate = projectRunOut({
    today: "2026-09-25",
    onHand: coffee.onHand,
    burn: coffee.burnRatePerEffectiveDay,
    reorderLevel: 0,
    weekendWeight: 0.2,
    closedWeekdays: 5
  }).expectedDate;
  const twentyDate = projectRunOut({
    today: "2026-09-25",
    onHand: coffee.onHand,
    burn: coffee.burnRatePerEffectiveDay,
    reorderLevel: 0,
    weekendWeight: 0.2,
    closedWeekdays: 20
  }).expectedDate;
  assert.ok(fiveDate > screen);
  assert.ok(twentyDate > fiveDate);
  assert.match(five, new RegExp(longDate(fiveDate)));
  assert.match(twenty, new RegExp(longDate(twentyDate)));
  const unchanged = await getPantry(db, meera, officeId, "2026-09");
  assert.equal(unchanged.products.find(product => product.name === "Coffee").expectedDate, screen);
  await db.close();
  fs.rmSync(file, {
    force: true
  });
});
test("an office manager deletes a product only after saying yes", async () => {
  const {
    db,
    meera,
    officeId,
    close
  } = await openPantry();
  const before = await getPantry(db, meera, officeId, "2026-09");
  const coffee = before.products.find(product => product.name === "Coffee");
  const asked = await converse(db, meera, [], "delete the coffee product");
  assert.match(asked.reply, /Coffee at Ahmedabad/);
  assert.match(asked.reply, /will be deleted/);
  assert.match(asked.reply, /Say yes and I'll do it/);
  assert.equal(asked.saved, false);
  assert.equal(asked.proposals.length, 1);
  const still = (await getPantry(db, meera, officeId, "2026-09")).products.find(product => product.name === "Coffee");
  assert.equal(still.deletedAt, null);
  assert.equal(still.onHand, coffee.onHand);
  const done = await converse(db, meera, [], "yes");
  assert.match(done.reply, /^Deleted\./);
  assert.equal(done.saved, true);
  const after = await getPantry(db, meera, officeId, "2026-09");
  assert.equal(after.products.some(product => product.name === "Coffee"), false);
  const row = await db.prepare("SELECT deleted_at FROM pantry_product WHERE id = ?").get(coffee.productId);
  assert.ok(row.deleted_at);
  const left = await db.prepare("SELECT COUNT(*) AS n FROM pantry_purchase WHERE product_id = ? AND deleted_at IS NULL").get(coffee.productId);
  assert.equal(left.n, 0);
  close();
});
test("saying no leaves the product, and accounts cannot delete", async () => {
  const {
    db,
    meera,
    officeId,
    close
  } = await openPantry();
  const kabir = (await signIn(db, "kabir.mehta@intuitive.AI")).person;
  const isha = (await signIn(db, "isha.rao@intuitive.AI")).person;
  const avery = (await signIn(db, "avery.shah@intuitive.AI")).person;
  const refused = await converse(db, kabir, [], "delete the coffee product");
  assert.match(refused.reply, /cannot delete/i);
  assert.equal(refused.proposals.length, 0);
  assert.match((await converse(db, isha, [], "remove milk")).reply, /cannot delete/i);
  await assert.rejects(async () => await createProposal(db, kabir, "delete_product", {
    office: "Ahmedabad",
    product: "Tea"
  }), error => error.status === 403);
  const which = await converse(db, avery, [], "delete coffee");
  assert.match(which.reply, /Which office/);
  assert.equal(which.proposals.length, 0);
  const asked = await converse(db, meera, [], "delete tea");
  assert.match(asked.reply, /Say yes and I'll do it/);
  const stopped = await converse(db, meera, [], "no");
  assert.match(stopped.reply, /Left unsaved/);
  const tea = (await getPantry(db, meera, officeId, "2026-09")).products.find(product => product.name === "Tea");
  assert.equal(tea.deletedAt, null);
  close();
});
test("a single purchase or count is deleted only after yes", async () => {
  const {
    db,
    meera,
    officeId,
    close
  } = await openPantry();
  const purchase = await db.prepare(`SELECT purchased_on, packs FROM (
         SELECT p.purchased_on, p.packs, COUNT(*) AS n
         FROM pantry_purchase p
         JOIN pantry_product pr ON pr.id = p.product_id
         WHERE pr.name = 'Milk' AND pr.office_id = ? AND p.deleted_at IS NULL
         GROUP BY p.purchased_on, p.packs
       ) WHERE n = 1
       ORDER BY purchased_on DESC LIMIT 1`).get(officeId);
  assert.ok(purchase);
  const asked = await converse(db, meera, [], `delete the milk purchase of ${purchase.packs} packs on ${purchase.purchased_on}`);
  assert.match(asked.reply, /purchase of/);
  assert.match(asked.reply, /Say yes and I'll do it/);
  assert.equal((await db.prepare("SELECT p.deleted_at FROM pantry_purchase p JOIN pantry_product pr ON pr.id = p.product_id WHERE pr.name = 'Milk' AND p.purchased_on = ? AND p.packs = ?").get(purchase.purchased_on, purchase.packs)).deleted_at, null);
  const done = await converse(db, meera, [], "yes");
  assert.match(done.reply, /^Deleted\./);
  const removed = await db.prepare(`SELECT p.deleted_at FROM pantry_purchase p
       JOIN pantry_product pr ON pr.id = p.product_id
       WHERE pr.name = 'Milk' AND p.purchased_on = ? AND p.packs = ?`).get(purchase.purchased_on, purchase.packs);
  assert.ok(removed.deleted_at);
  assert.ok((await getPantry(db, meera, officeId, "2026-09")).products.some(product => product.name === "Milk" && !product.deletedAt));
  const count = await db.prepare(`SELECT c.counted_on, c.packs FROM pantry_count c
       JOIN pantry_product pr ON pr.id = c.product_id
       WHERE pr.name = 'Sticks' AND pr.office_id = ? AND c.deleted_at IS NULL
       ORDER BY c.counted_on DESC LIMIT 1`).get(officeId);
  const countAsk = await converse(db, meera, [], `delete the sticks count on ${count.counted_on}`);
  assert.match(countAsk.reply, /shelf count/);
  assert.match(countAsk.reply, /Say yes and I'll do it/);
  await converse(db, meera, [], "yes");
  const countRow = await db.prepare(`SELECT c.deleted_at FROM pantry_count c
       JOIN pantry_product pr ON pr.id = c.product_id
       WHERE pr.name = 'Sticks' AND c.counted_on = ?`).get(count.counted_on);
  assert.ok(countRow.deleted_at);
  close();
});
test("a prepared reply is streamed in more than one piece", async () => {
  const {
    db,
    meera,
    close
  } = await openPantry();
  const pieces = [];
  const result = await converse(db, meera, [], "how much milk is left and when will it run out?", {
    onDelta: piece => pieces.push(piece)
  });
  assert.equal(pieces.join(""), result.reply);
  assert.ok(result.reply.length > 32);
  assert.ok(pieces.length > 1);
  close();
});
async function openPantry() {
  setClock(() => new Date("2026-09-25T06:00:00.000Z"));
  const file = path.join(os.tmpdir(), `aim-del-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  const db = await openDatabase(file);
  const meera = (await signIn(db, "meera.patel@intuitive.AI")).person;
  const officeId = (await db.prepare("SELECT id FROM office WHERE name = 'Ahmedabad'").get()).id;
  return {
    db,
    meera,
    officeId,
    async close() {
      await db.close();
      fs.rmSync(file, {
        force: true
      });
    }
  };
}
function longDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day))).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("yes in another chat cannot confirm a deletion from the first chat", async () => {
  const { db, meera, close } = await openPantry();
  try {
    const first = await converse(db, meera, [], "delete the coffee product", { threadId: "first-thread" });
    assert.equal(first.proposals.length, 1);
    const second = await converse(db, meera, [], "yes", { threadId: "second-thread" });
    assert.equal(second.saved, false);
  } finally { await close(); }
});
