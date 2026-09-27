process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-must-be-32-characters";
process.env.PANTRY_SEED = "production";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { passwordProblems } from "./passwords.js";
import { completePasswordSetup, invitePerson, loginWithPassword, openDatabase, rotateRefresh, signIn } from "./service.js";
test("a chosen password needs 12 characters, mixed case, and a number", () => {
  assert.ok(passwordProblems("short", "a@intuitive.AI").length);
  assert.ok(passwordProblems("alllowercase12", "a@intuitive.AI").length);
  assert.ok(passwordProblems("Password123", "siddharth.kalyani@intuitive.AI").length);
  assert.equal(passwordProblems("Pantry Door 19", "siddharth.kalyani@intuitive.AI").length, 0);
});
test("only an invited intuitive.AI email can set a password and stay signed in", async () => {
  const file = path.join(os.tmpdir(), `aim-pass-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  const db = await openDatabase(file, {
    seed: "production"
  });
  try {
    const siddharth = (await signIn(db, "Siddharth.Kalyani@intuitive.AI")).person;
    await assert.rejects(async () => await invitePerson(db, siddharth, {
      email: "guest@gmail.com",
      displayName: "Guest"
    }), error => error.status === 422);
    await assert.rejects(async () => await loginWithPassword(db, "meera.patel@intuitive.AI", "Pantry Door 19"), error => error.status === 401);
    const invite = await invitePerson(db, siddharth, {
      email: "Siddharth.Kalyani@intuitive.AI"
    });
    assert.match(invite.temporaryPassword, /^[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+$/);
    const setup = await loginWithPassword(db, invite.email, invite.temporaryPassword);
    assert.equal(setup.next, "setup");
    assert.equal(setup.email, "Siddharth.Kalyani@intuitive.AI");
    await assert.rejects(async () => await completePasswordSetup(db, setup.setupToken, "Pantry Door 19", "Pantry Door 18"), error => error.status === 422);
    const done = await completePasswordSetup(db, setup.setupToken, "Pantry Door 19", "Pantry Door 19");
    assert.equal(done.next, "app");
    assert.equal(done.person.superAdmin, true);
    const again = await loginWithPassword(db, invite.email, "Pantry Door 19");
    assert.equal(again.next, "app");
    const refreshed = await rotateRefresh(db, again.refreshToken);
    assert.equal(refreshed.person.email, "Siddharth.Kalyani@intuitive.AI");
    assert.notEqual(refreshed.refreshToken, again.refreshToken);
    await assert.rejects(async () => await rotateRefresh(db, again.refreshToken), error => error.status === 401);
    await assert.rejects(async () => await rotateRefresh(db, refreshed.refreshToken), error => error.status === 401);
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
