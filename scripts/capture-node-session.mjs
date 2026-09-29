// Capture synthetic credentials/data from the original backend for cutover tests.
// Usage: node scripts/capture-node-session.mjs ORIGINAL_CHECKOUT OUTPUT.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const s = await import(pathToFileURL(path.join(source, 'server/service.js')));
const secret = await import(pathToFileURL(path.join(source, 'server/secret.js')));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-session-contract-'));
process.env.SESSION_SECRET = 'local-test-secret-never-use-in-a-real-deployment-42';
const db = await s.openDatabase(path.join(directory, 'source.sqlite'), { seed: 'fixtures' });
s.setClock(() => new Date('2026-09-20T06:30:00.000Z'));
try {
  const admin = (await s.signIn(db, 'avery.shah@intuitive.AI')).person;
  const invitation = await s.invitePerson(db, admin, { email: admin.email });
  const ticket = await s.loginWithPassword(db, invitation.email, invitation.temporaryPassword);
  const password = 'Node portable door 42';
  await s.completePasswordSetup(db, ticket.setupToken, password, password);
  const session = await s.beginBrowserSession(db, admin.id);
  await s.storeGraphRefresh(db, session.refreshId, secret.seal('portable-graph-refresh'));
  const pending = await s.invitePerson(db, admin, { email: 'pending.member@intuitive.AI', displayName: 'Pending Member' });
  const setup = await s.loginWithPassword(db, pending.email, pending.temporaryPassword);
  const tables = ['person', 'office', 'role_grant', 'company_setting', 'session', 'refresh_token', 'setup_ticket'];
  const rows = Object.fromEntries(await Promise.all(tables.map(async table => [table, await db.prepare(`SELECT * FROM ${table}`).all()])));
  fs.writeFileSync(output, JSON.stringify({ sourceCommit: '275a403b659f2289ecf0e901769e145238e721e7', clock: '2026-09-20T06:30:00.000Z', issuedAt: Math.floor(Date.now() / 1000), admin, password, session, setup, rows }, null, 2) + '\n');
  console.log('Captured synthetic Node sessions and pending setup for cutover checks.');
} finally { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
