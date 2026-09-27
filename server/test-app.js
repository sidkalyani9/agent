import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ROOT } from "./config.js";
import * as s from "./service.js";

export async function startTestApp({ port = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pantry-http-"));
  const file = path.join(dir, "test.sqlite");
  const secret = "local-test-secret-never-use-in-a-real-deployment-42";
  process.env.SESSION_SECRET = secret;
  const db = await s.openDatabase(file, { seed: "fixtures" });
  const admin = (await s.signIn(db, "avery.shah@intuitive.AI")).person;
  const manager = (await s.signIn(db, "meera.patel@intuitive.AI")).person;
  const reader = (await s.signIn(db, "kabir.mehta@intuitive.AI")).person;
  const sessions = { admin: await s.beginBrowserSession(db, admin.id), manager: await s.beginBrowserSession(db, manager.id), reader: await s.beginBrowserSession(db, reader.id) };
  const invite = await s.invitePerson(db, admin, { email: admin.email });
  const setup = await s.loginWithPassword(db, invite.email, invite.temporaryPassword);
  const password = "Local test login 42";
  await s.completePasswordSetup(db, setup.setupToken, password, password);
  sessions.admin = await s.beginBrowserSession(db, admin.id);
  const offices = await s.listOffices(db, admin);
  const child = spawn(process.execPath, ["server/index.js"], { cwd: ROOT, env: {
    ...process.env, NODE_ENV: "test", PANTRY_DB: file, DATABASE_URL: "", PANTRY_DATA_DIR: dir,
    SESSION_SECRET: secret, PANTRY_SEED: "fixtures", PORT: String(port), PANTRY_HOST: "127.0.0.1",
    APP_ORIGIN: `http://127.0.0.1:${port || 5173}`, WEBSITE_SITE_NAME: "", PANTRY_TRUST_PROXY: "",
    ENTRA_TENANT_ID: "", ENTRA_CLIENT_ID: "", ENTRA_CLIENT_SECRET: "", AZURE_STORAGE_ACCOUNT_URL: "",
    OPENROUTER_API_KEY: "", TOKENROUTER_API_KEY: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Test server did not start.")); }, 15000);
    child.stdout.on("data", bytes => {
      const match = String(bytes).match(/Pantry API on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Test server exited (${code}).`)); });
    child.once("error", reject);
    child.stderr.on("data", bytes => { if (process.env.PANTRY_TEST_DEBUG) process.stderr.write(bytes); });
  });
  return { base, db, dir, admin, manager, reader, offices, sessions, password,
    async close() {
      const exited = once(child, "exit");
      child.kill("SIGTERM"); await exited;
      await db.close(); fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
