import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { intuitiveSignInName } from "./identity.js";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashToken,
  passwordProblems,
  randomInvitePassword,
  signAccess,
  signSetup,
  verifyAccess,
  verifyPassword,
  verifySetup,
} from "./passwords.js";
import {
  addMoney,
  computeProduct,
  formatWhen,
  money,
  monthFigures,
  monthHistory,
  nextMonthFrame,
  projectMonth,
  stockSeries,
  todayInIndia,
} from "./calc.js";

const STARTERS = ["Coffee", "Milk", "Sugar", "Tea", "Sticks"];
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
const ROLES = new Set(["super_admin", "office_manager", "admin", "accounts"]);
let clock = () => new Date();

export function setClock(fn) {
  clock = fn || (() => new Date());
}

export function now() {
  return clock();
}

export class HttpError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function openDatabase(file, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  const mode = options.seed || (process.env.PANTRY_SEED === "fixtures" ? "fixtures" : "production");
  if (mode === "fixtures") {
    if (!db.prepare("SELECT id FROM office LIMIT 1").get()) seed(db);
    applyDemoHistory(db);
  } else {
    seedProduction(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person (
      id TEXT PRIMARY KEY,
      directory_object_id TEXT UNIQUE,
      sign_in_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      home_office_id TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS office (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_grant (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      role TEXT NOT NULL,
      office_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS company_setting (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      weekend_weight REAL NOT NULL,
      lookback_months INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pantry_product (
      id TEXT PRIMARY KEY,
      office_id TEXT NOT NULL,
      name TEXT NOT NULL,
      reorder_level INTEGER NOT NULL,
      warning_effective_days INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pantry_purchase (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      purchased_on TEXT NOT NULL,
      packs INTEGER NOT NULL,
      price_per_pack TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pantry_count (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      counted_on TEXT NOT NULL,
      packs INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT,
      UNIQUE (product_id, counted_on)
    );
    CREATE TABLE IF NOT EXISTS pantry_receipt (
      purchase_id TEXT PRIMARY KEY,
      blob_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS operation (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      office_id TEXT,
      at TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session (
      token_hash TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      graph_refresh TEXT
    );
    CREATE TABLE IF NOT EXISTS login_attempt (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refresh_token (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      family_id TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      graph_refresh TEXT,
      expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      replaced_by TEXT
    );
    CREATE INDEX IF NOT EXISTS refresh_token_family ON refresh_token(family_id);
    CREATE TABLE IF NOT EXISTS setup_ticket (
      jti_hash TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      person_id TEXT NOT NULL,
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (person_id, key)
    );
    CREATE TABLE IF NOT EXISTS proposal (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      summary TEXT NOT NULL,
      office_id TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_thread (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_message (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      proposals TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_thread_person ON chat_thread(person_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS chat_message_thread ON chat_message(thread_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS product_name_active
      ON pantry_product(office_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS grant_active
      ON role_grant(person_id, role, ifnull(office_id, '')) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS person_sign_in_lower ON person(lower(sign_in_name));
  `);
  const sessionCols = db.prepare("PRAGMA table_info(session)").all().map((column) => column.name);
  if (sessionCols.includes("token") && !sessionCols.includes("token_hash")) {
    db.exec("DROP TABLE session");
    db.exec(`
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        graph_refresh TEXT
      );
    `);
  }
  for (const [name, ddl] of [
    ["password_hash", "password_hash TEXT"],
    ["must_set_password", "must_set_password INTEGER NOT NULL DEFAULT 0"],
    ["failed_attempts", "failed_attempts INTEGER NOT NULL DEFAULT 0"],
    ["locked_until", "locked_until TEXT"],
    ["invited_at", "invited_at TEXT"],
  ]) {
    const columns = db.prepare("PRAGMA table_info(person)").all();
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE person ADD COLUMN ${ddl}`);
    }
  }
  const setting = db.prepare("SELECT id FROM company_setting WHERE id = 1").get();
  if (!setting) {
    db.prepare("INSERT INTO company_setting (id, weekend_weight, lookback_months) VALUES (1, 0.2, 3)").run();
  }
}

function id() {
  return crypto.randomUUID();
}

function stamp() {
  return now().toISOString();
}

function cleanName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 120);
}

function personById(db, personId) {
  return db.prepare("SELECT * FROM person WHERE id = ?").get(personId);
}

const ROLE_LABEL = {
  super_admin: "Super Admin",
  office_manager: "Office Manager",
  admin: "Admin",
  accounts: "Accounts",
};

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function createSession(db, personId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(32).toString("base64url");
  const created = now().getTime();
  const createdAt = new Date(created).toISOString();
  const expiresAt = new Date(created + 8 * 60 * 60 * 1000).toISOString();
  const absoluteExpiresAt = new Date(created + 12 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO session
      (token_hash, person_id, csrf_token, created_at, expires_at, absolute_expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(tokenHash(token), personId, csrf, createdAt, expiresAt, absoluteExpiresAt);
  return { token, csrf };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare("DELETE FROM session WHERE token_hash = ?").run(tokenHash(token));
}

export function sessionFromToken(db, token) {
  if (!token || String(token).length < 40) return null;
  const hash = tokenHash(token);
  const row = db
    .prepare(
      `SELECT s.csrf_token, s.expires_at, s.absolute_expires_at, p.*
       FROM session s JOIN person p ON p.id = s.person_id
       WHERE s.token_hash = ? AND p.active = 1`,
    )
    .get(hash);
  if (!row) return null;
  const nowIso = stamp();
  if (row.expires_at <= nowIso || row.absolute_expires_at <= nowIso) {
    db.prepare("DELETE FROM session WHERE token_hash = ?").run(hash);
    return null;
  }
  const idle = new Date(now().getTime() + 8 * 60 * 60 * 1000).toISOString();
  const next = idle < row.absolute_expires_at ? idle : row.absolute_expires_at;
  if (next > row.expires_at) {
    db.prepare("UPDATE session SET expires_at = ? WHERE token_hash = ?").run(next, hash);
  }
  return { csrf: row.csrf_token, person: presentPerson(db, row), token };
}

export function signIn(db, email) {
  const signInName = intuitiveSignInName(email);
  if (!signInName) throw new HttpError(401, "Only an @intuitive.AI sign-in can open this pantry.");
  const person = db.prepare("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE").get(signInName);
  if (!person || !person.active) {
    throw new HttpError(401, "That @intuitive.AI sign-in is not on this pantry yet.");
  }
  const session = createSession(db, person.id);
  return { token: session.token, person: presentPerson(db, person) };
}

export function saveLoginAttempt(db, { state, verifier, nonce, purpose }) {
  const at = stamp();
  const expires = new Date(now().getTime() + 10 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM login_attempt WHERE expires_at <= ?").run(at);
  db.prepare(
    `INSERT INTO login_attempt (state, code_verifier, nonce, purpose, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(state, verifier, nonce, purpose === "directory" ? "directory" : "login", at, expires);
}

export function takeLoginAttempt(db, state) {
  const row = db.prepare("SELECT * FROM login_attempt WHERE state = ?").get(state);
  if (!row) return null;
  db.prepare("DELETE FROM login_attempt WHERE state = ?").run(state);
  if (row.expires_at <= stamp()) return null;
  return row;
}

export function storeGraphRefresh(db, refreshId, sealed) {
  db.prepare("UPDATE refresh_token SET graph_refresh = ? WHERE id = ? AND revoked_at IS NULL").run(sealed, refreshId);
}

export function graphRefreshFor(db, refreshId) {
  const row = db.prepare("SELECT graph_refresh FROM refresh_token WHERE id = ? AND revoked_at IS NULL").get(refreshId);
  return row?.graph_refresh || "";
}

function nameFromEmail(email) {
  const local = String(email || "").split("@")[0].replace(/[._+-]+/g, " ").trim();
  return cleanName(local.replace(/\b\w/g, (letter) => letter.toUpperCase()));
}

export function beginBrowserSession(db, personId, options = {}) {
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  const refreshId = id();
  const csrf = crypto.randomBytes(32).toString("base64url");
  const created = now().getTime();
  const createdAt = new Date(created).toISOString();
  const sliding = new Date(created + 30 * 24 * 60 * 60 * 1000).toISOString();
  const absolute = options.absolute || new Date(created + 90 * 24 * 60 * 60 * 1000).toISOString();
  const expiresAt = sliding < absolute ? sliding : absolute;
  db.prepare(
    `INSERT INTO refresh_token
      (id, person_id, token_hash, family_id, csrf_token, graph_refresh, expires_at, absolute_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    refreshId,
    personId,
    hashToken(refreshToken),
    options.familyId || id(),
    csrf,
    options.graphRefresh || null,
    expiresAt,
    absolute,
    createdAt,
  );
  return {
    accessToken: signAccess({ sub: personId, sid: refreshId, csrf }),
    refreshToken,
    csrf,
    refreshId,
  };
}

export function personFromAccessToken(db, token) {
  const claims = verifyAccess(token);
  if (!claims) return null;
  const person = personById(db, claims.sub);
  if (!person?.active) return null;
  const refresh = db.prepare("SELECT id, revoked_at, expires_at FROM refresh_token WHERE id = ?").get(claims.sid);
  if (!refresh || refresh.revoked_at || refresh.expires_at <= stamp()) return null;
  return { person: presentPerson(db, person), csrf: claims.csrf, refreshId: refresh.id };
}

export function revokeBrowserSession(db, refreshId) {
  if (!refreshId) return;
  const row = db.prepare("SELECT family_id FROM refresh_token WHERE id = ?").get(refreshId);
  if (!row) return;
  db.prepare("UPDATE refresh_token SET revoked_at = coalesce(revoked_at, ?) WHERE family_id = ?").run(stamp(), row.family_id);
}

export function rotateRefresh(db, rawToken) {
  if (!rawToken) throw new HttpError(401, "Sign in again.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM refresh_token WHERE token_hash = ?").get(hashToken(rawToken));
    if (!row) {
      db.exec("ROLLBACK");
      throw new HttpError(401, "Sign in again.");
    }
    if (row.revoked_at || row.expires_at <= stamp() || row.absolute_expires_at <= stamp()) {
      db.prepare("UPDATE refresh_token SET revoked_at = coalesce(revoked_at, ?) WHERE family_id = ?").run(stamp(), row.family_id);
      db.exec("COMMIT");
      throw new HttpError(401, "Sign in again.");
    }
    const person = personById(db, row.person_id);
    if (!person?.active) {
      db.prepare("UPDATE refresh_token SET revoked_at = coalesce(revoked_at, ?) WHERE family_id = ?").run(stamp(), row.family_id);
      db.exec("COMMIT");
      throw new HttpError(401, "Sign in again.");
    }
    db.prepare("UPDATE refresh_token SET revoked_at = ? WHERE id = ?").run(stamp(), row.id);
    const issued = beginBrowserSession(db, person.id, {
      familyId: row.family_id,
      absolute: row.absolute_expires_at,
      graphRefresh: row.graph_refresh,
    });
    db.prepare("UPDATE refresh_token SET replaced_by = ? WHERE id = ?").run(issued.refreshId, row.id);
    db.exec("COMMIT");
    return { ...issued, person: presentPerson(db, person) };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw error;
  }
}

function noteFailedPassword(db, person) {
  const attempts = Number(person.failed_attempts || 0) + 1;
  if (attempts >= 5) {
    const locked = new Date(now().getTime() + 15 * 60 * 1000).toISOString();
    db.prepare("UPDATE person SET failed_attempts = 0, locked_until = ? WHERE id = ?").run(locked, person.id);
    return;
  }
  db.prepare("UPDATE person SET failed_attempts = ? WHERE id = ?").run(attempts, person.id);
}

export function loginWithPassword(db, email, password) {
  const signInName = intuitiveSignInName(email);
  if (!signInName) throw new HttpError(401, "Use an @intuitive.AI email.");
  const person = db.prepare("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE").get(signInName);
  if (person?.locked_until && person.locked_until > stamp()) {
    throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.");
  }
  const passwordOk = verifyPassword(password, person?.password_hash || DUMMY_PASSWORD_HASH);
  if (!person || !person.password_hash || !passwordOk) {
    if (person?.password_hash) noteFailedPassword(db, person);
    if (!person || !person.password_hash) throw new HttpError(401, "This email is not invited.");
    throw new HttpError(401, "That password is not right.");
  }
  if (!person.active) throw new HttpError(403, "This account is turned off. A Super Admin can turn it back on.", "inactive");
  db.prepare("UPDATE person SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(person.id);
  if (person.must_set_password) {
    const jti = id();
    const setupToken = signSetup({ sub: person.id, email: person.sign_in_name, jti });
    const expires = new Date(now().getTime() + 15 * 60 * 1000).toISOString();
    db.prepare("DELETE FROM setup_ticket WHERE person_id = ?").run(person.id);
    db.prepare("INSERT INTO setup_ticket (jti_hash, person_id, expires_at) VALUES (?, ?, ?)").run(hashToken(jti), person.id, expires);
    return { next: "setup", email: person.sign_in_name, setupToken };
  }
  return { next: "app", person: presentPerson(db, person), ...beginBrowserSession(db, person.id) };
}

export function setupContext(db, token) {
  const claims = verifySetup(token);
  if (!claims) return null;
  const ticket = db.prepare("SELECT * FROM setup_ticket WHERE jti_hash = ?").get(hashToken(claims.jti));
  if (!ticket || ticket.used_at || ticket.expires_at <= stamp() || ticket.person_id !== claims.sub) return null;
  const person = personById(db, claims.sub);
  if (!person?.active || !person.must_set_password) return null;
  return { email: person.sign_in_name };
}

export function completePasswordSetup(db, token, password, confirm) {
  if (String(password || "") !== String(confirm || "")) throw new HttpError(422, "Those passwords do not match.");
  const claims = verifySetup(token);
  if (!claims) throw new HttpError(401, "Sign in with the invite password again.");
  const ticket = db.prepare("SELECT * FROM setup_ticket WHERE jti_hash = ?").get(hashToken(claims.jti));
  if (!ticket || ticket.used_at || ticket.expires_at <= stamp() || ticket.person_id !== claims.sub) {
    throw new HttpError(401, "That setup step expired. Sign in with the invite password again.");
  }
  const person = personById(db, claims.sub);
  if (!person?.active) throw new HttpError(403, "This account is turned off. A Super Admin can turn it back on.");
  const problems = passwordProblems(password, person.sign_in_name);
  if (problems.length) throw new HttpError(422, problems[0]);
  if (person.password_hash && verifyPassword(password, person.password_hash)) {
    throw new HttpError(422, "Choose a password that is different from the invite password.");
  }
  db.prepare(
    "UPDATE person SET password_hash = ?, must_set_password = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?",
  ).run(hashPassword(password), person.id);
  db.prepare("UPDATE setup_ticket SET used_at = ? WHERE jti_hash = ?").run(stamp(), hashToken(claims.jti));
  return { next: "app", person: presentPerson(db, personById(db, person.id)), ...beginBrowserSession(db, person.id) };
}

export function invitePerson(db, actor, input) {
  if (!actor?.superAdmin) throw new HttpError(403, "Only a Super Admin can invite someone.");
  const signInName = intuitiveSignInName(input?.email || input?.signInName);
  if (!signInName) throw new HttpError(422, "Use an @intuitive.AI email.");
  const existing = db.prepare("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE").get(signInName);
  if (existing?.password_hash && !existing.must_set_password) {
    throw new HttpError(422, "That person already chose a password.");
  }
  const displayName = cleanName(input?.displayName) || existing?.display_name || nameFromEmail(signInName);
  if (displayName.length < 2) throw new HttpError(422, "Enter the person's name.");
  const temporaryPassword = randomInvitePassword();
  const passwordHash = hashPassword(temporaryPassword);
  let personId = existing?.id;
  if (!existing) {
    personId = id();
    db.prepare(
      `INSERT INTO person
        (id, sign_in_name, display_name, active, password_hash, must_set_password, invited_at, failed_attempts)
       VALUES (?, ?, ?, 1, ?, 1, ?, 0)`,
    ).run(personId, signInName, displayName, passwordHash, stamp());
    log(db, actor.id, "person.add", "person", personId, null, `Invited ${displayName}.`);
  } else {
    db.prepare(
      `UPDATE person
       SET display_name = ?, active = 1, password_hash = ?, must_set_password = 1, invited_at = ?,
           failed_attempts = 0, locked_until = NULL
       WHERE id = ?`,
    ).run(displayName, passwordHash, stamp(), personId);
    log(db, actor.id, "person.invite", "person", personId, null, `Sent a new invite password for ${displayName}.`);
  }
  return { email: signInName, displayName, temporaryPassword };
}

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function acceptMicrosoftLogin(db, identity) {
  const signInName = intuitiveSignInName(identity?.signInName);
  if (!signInName) {
    throw new HttpError(403, "Only an @intuitive.AI Microsoft account can open this pantry.", "domain");
  }
  if (!OBJECT_ID.test(String(identity?.oid || ""))) {
    throw new HttpError(401, "Microsoft did not confirm this account.", "failed");
  }
  const byOid = db.prepare("SELECT * FROM person WHERE directory_object_id = ?").get(identity.oid);
  const byEmail = db.prepare("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE").get(signInName);
  if (byOid && byEmail && byOid.id !== byEmail.id) {
    throw new HttpError(403, "This Microsoft account does not match the pantry access list.", "not_on_list");
  }
  const person = byOid || byEmail;
  if (!person) {
    throw new HttpError(
      403,
      "This Microsoft account is not on the pantry access list. A Super Admin has to add it first.",
      "not_on_list",
    );
  }
  if (!person.active) {
    throw new HttpError(403, "This account is turned off. A Super Admin can turn it back on.", "inactive");
  }
  if (person.directory_object_id && person.directory_object_id !== identity.oid) {
    throw new HttpError(403, "This Microsoft account does not match the pantry access list.", "not_on_list");
  }
  const taken = db
    .prepare("SELECT id FROM person WHERE sign_in_name = ? COLLATE NOCASE AND id != ?")
    .get(signInName, person.id);
  if (taken) throw new HttpError(403, "This sign-in name is already on the pantry access list.", "not_on_list");
  const displayName = cleanName(identity.displayName) || person.display_name;
  db.prepare("UPDATE person SET directory_object_id = ?, sign_in_name = ?, display_name = ? WHERE id = ?").run(
    identity.oid,
    signInName,
    displayName,
    person.id,
  );
  return presentPerson(db, personById(db, person.id));
}

function grantsFor(db, personId) {
  return db
    .prepare(
      `SELECT g.id, g.role, g.office_id, o.name AS office_name
       FROM role_grant g LEFT JOIN office o ON o.id = g.office_id
       WHERE g.person_id = ? AND g.deleted_at IS NULL`,
    )
    .all(personId);
}

function presentPerson(db, person) {
  const grants = grantsFor(db, person.id);
  return {
    id: person.id,
    displayName: person.display_name,
    email: person.sign_in_name,
    active: Boolean(person.active),
    superAdmin: grants.some((grant) => grant.role === "super_admin"),
    admin: grants.some((grant) => grant.role === "admin"),
    seesEveryOffice: grants.some((grant) => grant.role === "super_admin" || grant.role === "admin"),
    grants: grants.map((grant) => ({
      id: grant.id,
      role: grant.role,
      officeId: grant.office_id,
      officeName: grant.office_name,
    })),
  };
}

function seesEveryOffice(person) {
  if (!person) return false;
  if (person.superAdmin || person.seesEveryOffice) return true;
  return person.grants?.some((grant) => grant.role === "admin" || grant.role === "super_admin");
}

function canWrite(person, officeId) {
  if (person.superAdmin) return true;
  return person.grants.some(
    (grant) => grant.role === "office_manager" && grant.officeId === officeId,
  );
}

function canView(person, officeId) {
  if (seesEveryOffice(person)) return true;
  return person.grants.some((grant) => grant.officeId === officeId);
}

function requireView(person, officeId) {
  if (!canView(person, officeId)) throw new HttpError(404, "Office not found.");
}

function requireWrite(person, officeId) {
  requireView(person, officeId);
  if (!canWrite(person, officeId)) {
    throw new HttpError(403, "This sign-in can view the office. It cannot change the pantry.");
  }
}

function log(db, actorId, action, entityType, entityId, officeId, summary) {
  db.prepare(
    `INSERT INTO operation (id, actor_id, action, entity_type, entity_id, office_id, at, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id(), actorId, action, entityType, entityId, officeId, stamp(), summary);
}

function settings(db) {
  const row = db.prepare("SELECT weekend_weight, lookback_months FROM company_setting WHERE id = 1").get();
  return { weekendWeight: row.weekend_weight, lookbackMonths: row.lookback_months };
}

function officeById(db, officeId) {
  return db.prepare("SELECT * FROM office WHERE id = ?").get(officeId);
}

export function listOffices(db, person) {
  const rows = seesEveryOffice(person)
    ? db.prepare("SELECT * FROM office ORDER BY name").all()
    : db
        .prepare(
          `SELECT DISTINCT o.* FROM office o
           JOIN role_grant g ON g.office_id = o.id
           WHERE g.person_id = ? AND g.deleted_at IS NULL
           ORDER BY o.name`,
        )
        .all(person.id);
  return rows.map((office) => ({ id: office.id, name: office.name }));
}

function insertProduct(db, actor, officeId, name, at = stamp()) {
  const productId = id();
  db.prepare(
    `INSERT INTO pantry_product
      (id, office_id, name, reorder_level, warning_effective_days, created_by, created_at)
     VALUES (?, ?, ?, 0, 5, ?, ?)`,
  ).run(productId, officeId, name, actor.id, at);
  db.prepare(
    `INSERT INTO pantry_count (id, product_id, counted_on, packs, created_by, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(id(), productId, todayInIndia(now()), actor.id, at);
  return productId;
}

export function createOffice(db, person, name, managerId) {
  if (!person.superAdmin) throw new HttpError(403, "Only a Super Admin can add an office.");
  const clean = String(name || "").trim();
  if (!clean || clean.length > 80) throw new HttpError(422, "An office name is required, up to 80 characters.");
  const existing = db.prepare("SELECT id FROM office WHERE name = ? COLLATE NOCASE").get(clean);
  if (existing) throw new HttpError(422, "An office with that name already exists.");
  const manager = managerId ? activePerson(db, managerId) : null;
  if (managerId && !manager) throw new HttpError(422, "Choose an Office Manager from the people on this pantry.");
  const at = stamp();
  const officeId = id();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO office (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(
      officeId,
      clean,
      person.id,
      at,
    );
    log(db, person.id, "office.create", "office", officeId, officeId, `Added the ${clean} office.`);
    for (const starter of STARTERS) {
      const productId = insertProduct(db, person, officeId, starter, at);
      log(db, person.id, "product.create", "product", productId, officeId, `Opened ${starter} at ${clean}.`);
    }
    if (manager) nameManager(db, person, { id: officeId, name: clean }, manager);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { id: officeId, name: clean, managerId: manager?.id || null, managerName: manager?.display_name || null };
}

export function assignOfficeManager(db, person, officeId, personId) {
  if (!person.superAdmin) throw new HttpError(403, "Only a Super Admin can assign an Office Manager.");
  const office = officeById(db, officeId);
  if (!office) throw new HttpError(404, "Office not found.");
  const manager = activePerson(db, personId);
  if (!manager) throw new HttpError(422, "Choose an Office Manager from the people on this pantry.");
  nameManager(db, person, office, manager);
  return { officeId: office.id, personId: manager.id, displayName: manager.display_name };
}

function activePerson(db, personId) {
  const manager = personById(db, personId);
  return manager?.active ? manager : null;
}

function nameManager(db, actor, office, manager) {
  const existing = db
    .prepare(
      `SELECT id FROM role_grant
       WHERE person_id = ? AND role = 'office_manager' AND office_id = ? AND deleted_at IS NULL`,
    )
    .get(manager.id, office.id);
  if (existing) throw new HttpError(422, `${manager.display_name} is already the Office Manager at ${office.name}.`);
  grant(db, actor.id, manager.id, "office_manager", office.id);
  log(
    db,
    actor.id,
    "grant.grant",
    "person",
    manager.id,
    office.id,
    `Named ${manager.display_name} Office Manager at ${office.name}.`,
  );
}

export function listPeople(db, person) {
  if (!person.superAdmin) throw new HttpError(403, "Only a Super Admin can assign an Office Manager.");
  return db
    .prepare("SELECT id, display_name, sign_in_name FROM person WHERE active = 1 ORDER BY display_name")
    .all()
    .map((row) => ({
      id: row.id,
      displayName: row.display_name,
      email: row.sign_in_name,
      managerOf: db
        .prepare(
          `SELECT o.id FROM role_grant g JOIN office o ON o.id = g.office_id
           WHERE g.person_id = ? AND g.role = 'office_manager' AND g.deleted_at IS NULL`,
        )
        .all(row.id)
        .map((office) => office.id),
    }));
}

function superAdminCount(db) {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT person_id) AS n FROM role_grant
       WHERE role = 'super_admin' AND deleted_at IS NULL`,
    )
    .get().n;
}

function presentAccess(db, person) {
  const presented = presentPerson(db, person);
  return {
    id: presented.id,
    displayName: presented.displayName,
    email: presented.email,
    active: presented.active,
    invitePending: Boolean(person.must_set_password),
    grants: presented.grants.map((grant) => ({
      id: grant.id,
      role: grant.role,
      officeId: grant.officeId,
      officeName: grant.officeName,
      label: grant.officeName ? `${ROLE_LABEL[grant.role]} · ${grant.officeName}` : ROLE_LABEL[grant.role],
    })),
  };
}

export function listAccess(db, actor) {
  if (!actor.superAdmin) throw new HttpError(403, "Only a Super Admin can manage access.");
  return db
    .prepare("SELECT * FROM person ORDER BY display_name")
    .all()
    .map((person) => presentAccess(db, person));
}

export function saveAccess(db, actor, input) {
  if (!actor.superAdmin) throw new HttpError(403, "Only a Super Admin can add someone or assign a role.");
  const signInName = intuitiveSignInName(input?.signInName);
  if (!signInName) throw new HttpError(422, "Use an @intuitive.AI sign-in name.");
  const displayName = cleanName(input?.displayName);
  if (displayName.length < 2) throw new HttpError(422, "Enter the person's name.");
  const role = String(input?.role || "");
  if (!ROLES.has(role)) throw new HttpError(422, "Choose a role.");
  const officeId = input?.officeId ? String(input.officeId) : null;
  if (role === "super_admin" || role === "admin") {
    if (officeId) {
      throw new HttpError(422, role === "admin" ? "Admin covers every office." : "Super Admin covers every office.");
    }
  } else if (!officeId || !officeById(db, officeId)) {
    throw new HttpError(422, "Choose an office for this role.");
  }
  const oid = input?.directoryObjectId ? String(input.directoryObjectId).trim() : null;
  if (oid && !OBJECT_ID.test(oid)) throw new HttpError(422, "That directory account is not valid.");
  const homeOfficeId = input?.homeOfficeId ? String(input.homeOfficeId) : null;
  if (homeOfficeId && !officeById(db, homeOfficeId)) throw new HttpError(422, "Choose a home office that exists.");

  let person = db.prepare("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE").get(signInName);
  if (oid) {
    const byOid = db.prepare("SELECT * FROM person WHERE directory_object_id = ?").get(oid);
    if (byOid && person && byOid.id !== person.id) {
      throw new HttpError(422, "That directory account is already on the access list.");
    }
    if (byOid && !person) person = byOid;
  }
  if (person) {
    const duplicate = db
      .prepare(
        `SELECT id FROM role_grant
         WHERE person_id = ? AND role = ? AND ifnull(office_id, '') = ifnull(?, '') AND deleted_at IS NULL`,
      )
      .get(person.id, role, officeId);
    if (duplicate) throw new HttpError(422, "That role is already assigned.");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!person) {
      const personId = id();
      db.prepare(
        `INSERT INTO person (id, directory_object_id, sign_in_name, display_name, home_office_id, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
      ).run(personId, oid, signInName, displayName, homeOfficeId);
      person = personById(db, personId);
      log(db, actor.id, "person.add", "person", personId, homeOfficeId, `Added ${displayName} to the access list.`);
    } else {
      db.prepare(
        `UPDATE person
         SET display_name = ?, active = 1, directory_object_id = coalesce(?, directory_object_id),
             sign_in_name = ?, home_office_id = coalesce(?, home_office_id)
         WHERE id = ?`,
      ).run(displayName, oid, signInName, homeOfficeId, person.id);
      person = personById(db, person.id);
    }
    grant(db, actor.id, person.id, role, officeId);
    const office = officeId ? officeById(db, officeId) : null;
    log(
      db,
      actor.id,
      "grant.grant",
      "grant",
      person.id,
      officeId,
      `Granted ${ROLE_LABEL[role]}${office ? ` at ${office.name}` : ""} to ${person.display_name}.`,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return presentAccess(db, personById(db, person.id));
}

export function removeGrant(db, actor, personId, grantId) {
  if (!actor.superAdmin) throw new HttpError(403, "Only a Super Admin can change access.");
  const row = db
    .prepare("SELECT * FROM role_grant WHERE id = ? AND person_id = ? AND deleted_at IS NULL")
    .get(grantId, personId);
  if (!row) throw new HttpError(404, "That access grant was not found.");
  if (row.role === "super_admin" && superAdminCount(db) <= 1) {
    throw new HttpError(422, "The last Super Admin has to stay on.");
  }
  db.prepare("UPDATE role_grant SET deleted_by = ?, deleted_at = ? WHERE id = ?").run(actor.id, stamp(), row.id);
  log(db, actor.id, "grant.remove", "grant", row.id, row.office_id, "Removed an access grant. The row stays.");
  return { id: row.id, removed: true };
}

export function setPersonActive(db, actor, personId, active) {
  if (!actor.superAdmin) throw new HttpError(403, "Only a Super Admin can change access.");
  const person = personById(db, personId);
  if (!person) throw new HttpError(404, "That person was not found.");
  const turnOn = Boolean(active);
  if (!turnOn) {
    const admins = superAdminCount(db);
    const isSuper = db
      .prepare(
        `SELECT id FROM role_grant
         WHERE person_id = ? AND role = 'super_admin' AND deleted_at IS NULL`,
      )
      .get(person.id);
    if (isSuper && admins <= 1) throw new HttpError(422, "The last Super Admin has to stay on.");
  }
  db.prepare("UPDATE person SET active = ? WHERE id = ?").run(turnOn ? 1 : 0, person.id);
  if (!turnOn) db.prepare("DELETE FROM session WHERE person_id = ?").run(person.id);
  log(
    db,
    actor.id,
    turnOn ? "person.restore" : "person.disable",
    "person",
    person.id,
    null,
    turnOn ? `Turned ${person.display_name} back on.` : `Turned ${person.display_name} off.`,
  );
  return { id: person.id, active: turnOn };
}

export function renameOffice(db, person, officeId, name) {
  if (!person.superAdmin) throw new HttpError(403, "Only a Super Admin can rename an office.");
  const office = officeById(db, officeId);
  if (!office) throw new HttpError(404, "Office not found.");
  const clean = String(name || "").trim();
  if (!clean || clean.length > 80) throw new HttpError(422, "An office name is required, up to 80 characters.");
  db.prepare("UPDATE office SET name = ? WHERE id = ?").run(clean, officeId);
  log(db, person.id, "office.rename", "office", officeId, officeId, `Renamed an office to ${clean}.`);
  return { id: officeId, name: clean };
}

function productsFor(db, officeId) {
  return db.prepare("SELECT * FROM pantry_product WHERE office_id = ? ORDER BY created_at, name").all(officeId);
}

function purchasesFor(db, productId) {
  return db
    .prepare("SELECT * FROM pantry_purchase WHERE product_id = ?")
    .all(productId)
    .map(presentPurchase);
}

function countsFor(db, productId) {
  return db.prepare("SELECT * FROM pantry_count WHERE product_id = ?").all(productId).map(presentCount);
}

function presentPurchase(row) {
  return {
    id: row.id,
    productId: row.product_id,
    purchasedOn: row.purchased_on,
    packs: row.packs,
    pricePerPack: row.price_per_pack,
    createdAt: row.created_at,
    createdBy: row.created_by,
    deletedAt: row.deleted_at,
  };
}

function presentCount(row) {
  return {
    id: row.id,
    productId: row.product_id,
    countedOn: row.counted_on,
    packs: row.packs,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

function namesById(db) {
  const map = new Map();
  for (const person of db.prepare("SELECT id, display_name FROM person").all()) {
    map.set(person.id, person.display_name);
  }
  return map;
}

export function getPantry(db, person, officeId, month, options = {}) {
  requireView(person, officeId);
  const office = officeById(db, officeId);
  if (!office) throw new HttpError(404, "Office not found.");
  const selected = month || todayInIndia(now()).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(selected)) throw new HttpError(422, "Month must look like 2026-09.");
  const today = todayInIndia(now());
  const config = settings(db);
  const names = namesById(db);
  const frame = nextMonthFrame(config, today);
  const products = productsFor(db, officeId).map((product) => {
    const purchases = purchasesFor(db, product.id);
    const counts = countsFor(db, product.id);
    const math = computeProduct({
      product: {
        reorderLevel: product.reorder_level,
        warningEffectiveDays: product.warning_effective_days,
      },
      purchases,
      counts,
      settings: config,
      today,
    });
    const monthStats = monthFigures(purchases, selected);
    const basis = monthFigures(purchases, today.slice(0, 7));
    const forecast = projectMonth({
      purchases,
      math,
      settings: config,
      today,
      basisPacks: basis.packsAdded,
      basisSpend: basis.spend,
    });
    const series =
      options.series === false
        ? null
        : stockSeries({
            purchases,
            counts,
            settings: config,
            today,
            burnRate: math.burnRatePerEffectiveDay,
            expectedDate: math.expectedDate,
            onHand: math.onHand,
          });
    const receipt = db
      .prepare(
        `SELECT purchase_id FROM pantry_receipt r
         JOIN pantry_purchase p ON p.id = r.purchase_id
         WHERE p.product_id = ? AND r.deleted_at IS NULL LIMIT 1`,
      )
      .get(product.id);
    return {
      productId: product.id,
      name: product.name,
      deletedAt: product.deleted_at,
      createdBy: names.get(product.created_by) || "Unknown",
      createdAt: product.created_at,
      createdAtLabel: formatWhen(product.created_at),
      reorderLevel: product.reorder_level,
      warningEffectiveDays: product.warning_effective_days,
      packsAdded: monthStats.packsAdded,
      spend: monthStats.spend,
      latestPricePerPack: monthStats.latestPricePerPack,
      onHand: math.onHand,
      burnRatePerEffectiveDay: math.burnRatePerEffectiveDay,
      expectedDate: math.expectedDate,
      coverEffectiveDays: math.coverEffectiveDays,
      status: math.status,
      message: math.message,
      trace: math.trace,
      history: monthHistory(purchases, config, today),
      forecast,
      ...(series ? { series } : {}),
      hasReceipt: Boolean(receipt),
    };
  });
  const visible = products.filter((product) => !product.deletedAt || product.packsAdded > 0);
  const forecastRows = products.filter((product) => !product.deletedAt && product.forecast.spend);
  return {
    officeId: office.id,
    officeName: office.name,
    month: selected,
    today,
    currency: "INR",
    spend: addMoney(visible.map((product) => product.spend)),
    forecast: {
      month: frame.month,
      effectiveDays: frame.effectiveDays,
      spend: forecastRows.length ? addMoney(forecastRows.map((product) => product.forecast.spend)) : null,
    },
    canWrite: canWrite(person, officeId),
    settings: config,
    products: visible,
  };
}

export function summary(db, person, month) {
  if (!seesEveryOffice(person)) throw new HttpError(403, "All offices is for a Super Admin or an Admin.");
  const selected = month || todayInIndia(now()).slice(0, 7);
  const offices = listOffices(db, person).map((office) => {
    const pantry = getPantry(db, person, office.id, selected, { series: false });
    return {
      officeId: office.id,
      name: office.name,
      spend: pantry.spend,
      forecastSpend: pantry.forecast.spend,
    };
  });
  const forecastRows = offices.filter((office) => office.forecastSpend);
  const frame = nextMonthFrame(settings(db), todayInIndia(now()));
  return {
    month: selected,
    forecastMonth: frame.month,
    effectiveDays: frame.effectiveDays,
    offices,
    spend: addMoney(offices.map((office) => office.spend)),
    forecastSpend: forecastRows.length ? addMoney(forecastRows.map((office) => office.forecastSpend)) : null,
  };
}

export function createProduct(db, person, officeId, name) {
  requireWrite(person, officeId);
  const office = officeById(db, officeId);
  const clean = String(name || "").trim();
  if (!clean) throw new HttpError(422, "A product needs a name.");
  const clash = db
    .prepare(
      "SELECT id FROM pantry_product WHERE office_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL",
    )
    .get(officeId, clean);
  if (clash) throw new HttpError(422, `${clean} is already on this office's pantry.`);
  const at = stamp();
  const productId = insertProduct(db, person, officeId, clean, at);
  log(db, person.id, "product.create", "product", productId, officeId, `Added ${clean} at ${office.name}.`);
  return { productId, name: clean };
}

export function updateProduct(db, person, productId, body) {
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(productId);
  if (!product) throw new HttpError(404, "Product not found.");
  requireWrite(person, product.office_id);
  const name = body.name != null ? String(body.name).trim() : product.name;
  const reorder = body.reorderLevel != null ? Number(body.reorderLevel) : product.reorder_level;
  const warning =
    body.warningEffectiveDays != null ? Number(body.warningEffectiveDays) : product.warning_effective_days;
  if (!name) throw new HttpError(422, "A product needs a name.");
  if (!Number.isInteger(reorder) || reorder < 0) throw new HttpError(422, "Reorder level is a whole number of packs, zero or more.");
  if (!Number.isInteger(warning) || warning < 1) throw new HttpError(422, "The warning window is at least 1 effective day.");
  db.prepare(
    `UPDATE pantry_product SET name = ?, reorder_level = ?, warning_effective_days = ? WHERE id = ?`,
  ).run(name, reorder, warning, productId);
  const action = name !== product.name ? "product.rename" : "product.reorder";
  log(db, person.id, action, "product", productId, product.office_id, `Updated ${name}.`);
  return { productId, name };
}

export function hideProduct(db, person, productId) {
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(productId);
  if (!product || product.deleted_at) throw new HttpError(404, "Product not found.");
  requireWrite(person, product.office_id);
  db.prepare("UPDATE pantry_product SET deleted_by = ?, deleted_at = ? WHERE id = ?").run(person.id, stamp(), productId);
  log(db, person.id, "product.hide", "product", productId, product.office_id, `Hid ${product.name}.`);
  return { productId, hidden: true };
}

export function deleteProduct(db, person, productId) {
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(productId);
  if (!product || product.deleted_at) throw new HttpError(404, "Product not found.");
  requireWrite(person, product.office_id);
  const at = stamp();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE pantry_receipt SET deleted_by = ?, deleted_at = ?
       WHERE deleted_at IS NULL AND purchase_id IN (SELECT id FROM pantry_purchase WHERE product_id = ?)`,
    ).run(person.id, at, productId);
    db.prepare(
      "UPDATE pantry_purchase SET deleted_by = ?, deleted_at = ? WHERE product_id = ? AND deleted_at IS NULL",
    ).run(person.id, at, productId);
    db.prepare(
      "UPDATE pantry_count SET deleted_by = ?, deleted_at = ? WHERE product_id = ? AND deleted_at IS NULL",
    ).run(person.id, at, productId);
    db.prepare("UPDATE pantry_product SET deleted_by = ?, deleted_at = ? WHERE id = ?").run(person.id, at, productId);
    log(db, person.id, "product.delete", "product", productId, product.office_id, `Deleted ${product.name}.`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { productId, deleted: true };
}

export function deletePurchase(db, person, purchaseId) {
  const purchase = db.prepare("SELECT * FROM pantry_purchase WHERE id = ? AND deleted_at IS NULL").get(purchaseId);
  if (!purchase) throw new HttpError(404, "Purchase not found.");
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(purchase.product_id);
  requireWrite(person, product.office_id);
  const at = stamp();
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE pantry_receipt SET deleted_by = ?, deleted_at = ? WHERE purchase_id = ? AND deleted_at IS NULL",
    ).run(person.id, at, purchaseId);
    db.prepare("UPDATE pantry_purchase SET deleted_by = ?, deleted_at = ? WHERE id = ?").run(person.id, at, purchaseId);
    log(
      db,
      person.id,
      "purchase.delete",
      "purchase",
      purchaseId,
      product.office_id,
      `Deleted a purchase of ${purchase.packs} packs of ${product.name} on ${purchase.purchased_on}.`,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { purchaseId, deleted: true };
}

export function deleteCount(db, person, countId) {
  const count = db.prepare("SELECT * FROM pantry_count WHERE id = ? AND deleted_at IS NULL").get(countId);
  if (!count) throw new HttpError(404, "Count not found.");
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(count.product_id);
  requireWrite(person, product.office_id);
  db.prepare("UPDATE pantry_count SET deleted_by = ?, deleted_at = ? WHERE id = ?").run(person.id, stamp(), countId);
  log(
    db,
    person.id,
    "count.delete",
    "count",
    countId,
    product.office_id,
    `Deleted the ${count.counted_on} shelf count of ${count.packs} packs of ${product.name}.`,
  );
  return { countId, deleted: true };
}

export function restoreProduct(db, person, productId) {
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(productId);
  if (!product || !product.deleted_at) throw new HttpError(404, "Product not found.");
  requireWrite(person, product.office_id);
  const clash = db
    .prepare(
      "SELECT id FROM pantry_product WHERE office_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL",
    )
    .get(product.office_id, product.name);
  if (clash) throw new HttpError(422, `${product.name} is already active at this office.`);
  db.prepare("UPDATE pantry_product SET deleted_by = NULL, deleted_at = NULL WHERE id = ?").run(productId);
  log(db, person.id, "product.restore", "product", productId, product.office_id, `Restored ${product.name}.`);
  return { productId, hidden: false };
}

function parsePacks(value, { allowZero = false } = {}) {
  const packs = Number(value);
  if (!Number.isInteger(packs) || packs < 0 || (!allowZero && packs < 1)) {
    throw new HttpError(422, allowZero ? "Packs are a whole number, zero or more." : "Packs are a whole number, at least 1.");
  }
  return packs;
}

function parsePrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) throw new HttpError(422, "Price per pack is zero or more.");
  return price.toFixed(2);
}

function parseDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(422, "Date must look like 2026-09-25.");
  const today = todayInIndia(now());
  if (date > today) throw new HttpError(422, "That date is still in the future for India.");
  return date;
}

function activeProduct(db, officeId, productId) {
  const product = db
    .prepare("SELECT * FROM pantry_product WHERE id = ? AND office_id = ?")
    .get(productId, officeId);
  if (!product || product.deleted_at) throw new HttpError(422, "That product is not available for a new entry.");
  return product;
}

function idempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new HttpError(422, "The save key is not valid. Retry the purchase.");
  }
  return key;
}

function purchaseHash(body, receipt) {
  const receiptHash = receipt?.bytes ? crypto.createHash("sha256").update(receipt.bytes).digest("hex") : "";
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        productId: body.productId,
        date: body.date,
        packs: body.packs,
        pricePerPack: body.pricePerPack,
        receipt: receiptHash,
      }),
    )
    .digest("hex");
}

export function createPurchase(db, person, officeId, body, receipt, idempotency) {
  requireWrite(person, officeId);
  const product = activeProduct(db, officeId, body.productId);
  const purchasedOn = parseDate(body.date);
  const packs = parsePacks(body.packs);
  const price = parsePrice(body.pricePerPack);
  const key = idempotencyKey(idempotency);
  const hash = key ? purchaseHash(body, receipt) : "";
  const at = stamp();
  const purchaseId = id();
  let result;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (key) {
      const prior = db.prepare("SELECT request_hash, body FROM idempotency WHERE person_id = ? AND key = ?").get(person.id, key);
      if (prior) {
        if (prior.request_hash !== hash) throw new HttpError(409, "This save was already sent with different details.");
        db.exec("ROLLBACK");
        result = JSON.parse(prior.body);
      }
    }
    if (!result) {
      db.prepare(
        `INSERT INTO pantry_purchase
          (id, product_id, purchased_on, packs, price_per_pack, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(purchaseId, product.id, purchasedOn, packs, price, person.id, at);
      log(
        db,
        person.id,
        "purchase.create",
        "purchase",
        purchaseId,
        officeId,
        `Entered ${packs} packs of ${product.name} on ${purchasedOn} at ₹${price}.`,
      );
      result = { purchaseId, product: product.name, date: purchasedOn, packs, pricePerPack: price, receiptSaved: false };
      if (key) {
        db.prepare(
          "INSERT INTO idempotency (person_id, key, request_hash, body, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(person.id, key, hash, JSON.stringify(result), at);
      }
      db.exec("COMMIT");
    }
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction is already closed */
    }
    throw error;
  }
  if (receipt && !result.receiptSaved) {
    try {
      saveReceipt(db, person, result.purchaseId, receipt, at);
      result.receiptSaved = true;
      delete result.receiptError;
      if (key) {
        db.prepare("UPDATE idempotency SET body = ? WHERE person_id = ? AND key = ?").run(
          JSON.stringify(result),
          person.id,
          key,
        );
      }
    } catch (error) {
      result.receiptError = error instanceof HttpError ? error.message : "The receipt could not be stored. The purchase is saved.";
    }
  }
  return result;
}

function sniffReceipt(bytes) {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  return "";
}

function safeReceiptName(name, fallback) {
  const base = path.basename(String(name || fallback)).replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 120);
  return base || fallback;
}

function saveReceipt(db, person, purchaseId, receipt, at) {
  if (!receipt?.bytes?.length) throw new HttpError(422, "The receipt file is empty.");
  if (receipt.bytes.length > 10 * 1024 * 1024) throw new HttpError(422, "A receipt is at most 10 MB.");
  const contentType = sniffReceipt(receipt.bytes);
  if (!contentType) throw new HttpError(422, "A receipt is a PDF, JPEG, or PNG.");
  const ext = contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
  const filename = `${purchaseId}.${ext}`;
  const full = receiptPath(filename);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const existing = db.prepare("SELECT purchase_id FROM pantry_receipt WHERE purchase_id = ?").get(purchaseId);
  const temp = `${full}.partial`;
  fs.writeFileSync(temp, receipt.bytes);
  fs.renameSync(temp, full);
  const fileName = safeReceiptName(receipt.fileName, filename);
  if (existing) {
    db.prepare(
      `UPDATE pantry_receipt
       SET blob_path = ?, file_name = ?, content_type = ?, byte_size = ?, deleted_by = NULL, deleted_at = NULL
       WHERE purchase_id = ?`,
    ).run(filename, fileName, contentType, receipt.bytes.length, purchaseId);
  } else {
    db.prepare(
      `INSERT INTO pantry_receipt
        (purchase_id, blob_path, file_name, content_type, byte_size, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(purchaseId, filename, fileName, contentType, receipt.bytes.length, person.id, at);
  }
  const product = db
    .prepare(
      `SELECT p.office_id, p.name FROM pantry_purchase u
       JOIN pantry_product p ON p.id = u.product_id WHERE u.id = ?`,
    )
    .get(purchaseId);
  log(
    db,
    person.id,
    existing ? "receipt.replace" : "receipt.attach",
    "receipt",
    purchaseId,
    product?.office_id || null,
    existing ? `Replaced the receipt on ${product?.name || "a purchase"}.` : `Attached a receipt to ${product?.name || "a purchase"}.`,
  );
}

export function attachReceipt(db, person, purchaseId, receipt) {
  const purchase = db.prepare("SELECT * FROM pantry_purchase WHERE id = ? AND deleted_at IS NULL").get(purchaseId);
  if (!purchase) throw new HttpError(404, "Purchase not found.");
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(purchase.product_id);
  requireWrite(person, product.office_id);
  saveReceipt(db, person, purchaseId, receipt, stamp());
  return { purchaseId, receiptSaved: true };
}

export function receiptFile(db, person, purchaseId) {
  const purchase = db.prepare("SELECT * FROM pantry_purchase WHERE id = ?").get(purchaseId);
  if (!purchase) throw new HttpError(404, "Purchase not found.");
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(purchase.product_id);
  requireView(person, product.office_id);
  const receipt = db.prepare("SELECT * FROM pantry_receipt WHERE purchase_id = ? AND deleted_at IS NULL").get(purchaseId);
  if (!receipt) throw new HttpError(404, "This purchase has no receipt.");
  const full = receiptPath(receipt.blob_path);
  if (!fs.existsSync(full)) throw new HttpError(404, "The receipt file is missing.");
  return { full, contentType: receipt.content_type, fileName: safeReceiptName(receipt.file_name, "receipt") };
}

function receiptPath(blobPath) {
  const root = path.resolve(dataDir, "receipts");
  const name = path.basename(String(blobPath || ""));
  if (!name || name !== blobPath) throw new HttpError(404, "This purchase has no receipt.");
  const full = path.resolve(root, name);
  if (!full.startsWith(root + path.sep)) throw new HttpError(404, "This purchase has no receipt.");
  return full;
}

export function correctPurchase(db, person, purchaseId, body) {
  const purchase = db.prepare("SELECT * FROM pantry_purchase WHERE id = ? AND deleted_at IS NULL").get(purchaseId);
  if (!purchase) throw new HttpError(404, "Purchase not found.");
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(purchase.product_id);
  requireWrite(person, product.office_id);
  const purchasedOn = body.date ? parseDate(body.date) : purchase.purchased_on;
  const packs = body.packs != null ? parsePacks(body.packs) : purchase.packs;
  const price = body.pricePerPack != null ? parsePrice(body.pricePerPack) : purchase.price_per_pack;
  db.prepare("UPDATE pantry_purchase SET purchased_on = ?, packs = ?, price_per_pack = ? WHERE id = ?").run(
    purchasedOn,
    packs,
    price,
    purchaseId,
  );
  log(
    db,
    person.id,
    "purchase.correct",
    "purchase",
    purchaseId,
    product.office_id,
    `Corrected ${product.name} to ${packs} packs on ${purchasedOn}. The original entry stays with its first person.`,
  );
  return { purchaseId };
}

export function hidePurchase(db, person, purchaseId) {
  const purchase = db.prepare("SELECT * FROM pantry_purchase WHERE id = ? AND deleted_at IS NULL").get(purchaseId);
  if (!purchase) throw new HttpError(404, "Purchase not found.");
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(purchase.product_id);
  requireWrite(person, product.office_id);
  db.prepare("UPDATE pantry_purchase SET deleted_by = ?, deleted_at = ? WHERE id = ?").run(person.id, stamp(), purchaseId);
  log(db, person.id, "purchase.hide", "purchase", purchaseId, product.office_id, `Withdrew a ${product.name} purchase. The row stays.`);
  return { purchaseId, hidden: true };
}

export function upsertCount(db, person, officeId, body) {
  requireWrite(person, officeId);
  const product = activeProduct(db, officeId, body.productId);
  const countedOn = parseDate(body.date);
  const packs = parsePacks(body.packs, { allowZero: true });
  const existing = db
    .prepare("SELECT * FROM pantry_count WHERE product_id = ? AND counted_on = ?")
    .get(product.id, countedOn);
  if (!existing) {
    const countId = id();
    db.prepare(
      `INSERT INTO pantry_count (id, product_id, counted_on, packs, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(countId, product.id, countedOn, packs, person.id, stamp());
    log(db, person.id, "count.enter", "count", countId, officeId, `Counted ${packs} packs of ${product.name} on ${countedOn}.`);
    return { countId };
  }
  db.prepare(
    "UPDATE pantry_count SET packs = ?, deleted_by = NULL, deleted_at = NULL WHERE id = ?",
  ).run(packs, existing.id);
  log(
    db,
    person.id,
    "count.correct",
    "count",
    existing.id,
    officeId,
    `Updated the ${countedOn} count of ${product.name} to ${packs}. The first person on that count stays.`,
  );
  return { countId: existing.id };
}

export function hideCount(db, person, countId) {
  const count = db.prepare("SELECT * FROM pantry_count WHERE id = ? AND deleted_at IS NULL").get(countId);
  if (!count) throw new HttpError(404, "Count not found.");
  const product = db.prepare("SELECT * FROM pantry_product WHERE id = ?").get(count.product_id);
  requireWrite(person, product.office_id);
  db.prepare("UPDATE pantry_count SET deleted_by = ?, deleted_at = ? WHERE id = ?").run(person.id, stamp(), countId);
  log(db, person.id, "count.hide", "count", countId, product.office_id, `Withdrew a count of ${product.name}. The row stays.`);
  return { countId, hidden: true };
}

export function listOperations(db, person, officeId, range = {}) {
  requireView(person, officeId);
  const names = namesById(db);
  const rows = db
    .prepare("SELECT * FROM operation WHERE office_id = ? ORDER BY at DESC")
    .all(officeId)
    .map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      at: row.at,
      day: todayInIndia(new Date(row.at)),
      atLabel: formatWhen(row.at),
      actor: names.get(row.actor_id) || "Unknown",
    }))
    .filter((row) => (!range.from || row.day >= range.from) && (!range.to || row.day <= range.to));
  return (range.from || range.to ? rows.slice(0, 300) : rows.slice(0, 40)).map(({ day, ...row }) => row);
}

export function exportCsv(db, person, officeId, month) {
  const pantry = getPantry(db, person, officeId, month);
  const lines = [
    ["Product", "Date", "Packs", "Price per pack (INR)", "Amount (INR)", "Receipt", "Entered by", "Entered at (IST)"],
  ];
  const names = namesById(db);
  for (const product of pantry.products) {
    const purchases = db
      .prepare(
        `SELECT * FROM pantry_purchase
         WHERE product_id = ? AND deleted_at IS NULL AND purchased_on LIKE ?
         ORDER BY purchased_on, created_at`,
      )
      .all(product.productId, `${pantry.month}%`);
    for (const purchase of purchases) {
      const receipt = db
        .prepare("SELECT purchase_id FROM pantry_receipt WHERE purchase_id = ? AND deleted_at IS NULL")
        .get(purchase.id);
      lines.push([
        product.name,
        purchase.purchased_on,
        String(purchase.packs),
        purchase.price_per_pack,
        money(purchase.packs, purchase.price_per_pack),
        receipt ? "Yes" : "No",
        names.get(purchase.created_by) || "Unknown",
        formatWhen(purchase.created_at),
      ]);
    }
  }
  lines.push(["Office total", "", "", "", pantry.spend, "", "", ""]);
  const csv = lines
    .map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  return { filename: `${pantry.officeName}-${pantry.month}.csv`, body: `\uFEFF${csv}` };
}

export function updateSettings(db, person, body) {
  if (!person.superAdmin) throw new HttpError(403, "Only a Super Admin can change the weekend weight or the lookback.");
  const weight = body.weekendWeight != null ? Number(body.weekendWeight) : settings(db).weekendWeight;
  const lookback = body.lookbackMonths != null ? Number(body.lookbackMonths) : settings(db).lookbackMonths;
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new HttpError(422, "Weekend weight is from 0 to 1.");
  if (!Number.isInteger(lookback) || lookback < 2 || lookback > 36) {
    throw new HttpError(422, "Lookback is a whole number of months from 2 to 36.");
  }
  db.prepare("UPDATE company_setting SET weekend_weight = ?, lookback_months = ? WHERE id = 1").run(weight, lookback);
  log(db, person.id, "settings.update", "settings", "00000000-0000-4000-8000-000000000001", null, `Set weekend weight to ${weight} and lookback to ${lookback} months.`);
  return settings(db);
}

const PROPOSALS = new Set([
  "create_product",
  "add_purchase",
  "add_count",
  "delete_product",
  "delete_purchase",
  "delete_count",
]);

export function createProposal(db, person, action, payload) {
  if (!PROPOSALS.has(action)) {
    throw new HttpError(403, "The assistant cannot hide, delete, restore, or correct a record.");
  }
  const office = resolveOffice(db, person, payload.office);
  if (action === "create_product") {
    requireWrite(person, office.id);
    const name = String(payload.name || "").trim();
    if (!name) throw new HttpError(422, "A product needs a name.");
    const summary = `Add product ${name} at ${office.name}.`;
    return storeProposal(db, person, action, { officeId: office.id, name }, summary, office.id);
  }
  if (action === "delete_product") {
    requireWrite(person, office.id);
    const product = resolveProduct(db, office.id, payload.product);
    const summary = `${product.name} at ${office.name}, including its purchases and shelf counts.`;
    return storeProposal(db, person, action, { officeId: office.id, productId: product.id }, summary, office.id);
  }
  if (action === "delete_purchase" || action === "delete_count") {
    requireWrite(person, office.id);
    const product = resolveProduct(db, office.id, payload.product || payload.productId);
    return action === "delete_purchase"
      ? proposeRowDelete(db, person, office, product, payload, "purchase")
      : proposeRowDelete(db, person, office, product, payload, "count");
  }
  const product = resolveProduct(db, office.id, payload.product);
  if (action === "add_purchase") {
    requireWrite(person, office.id);
    const date = parseDate(payload.date || todayInIndia(now()));
    const packs = parsePacks(payload.packs);
    const price = parsePrice(payload.pricePerPack);
    const summary = `Enter ${packs} packs of ${product.name} at ${office.name} on ${date}, at ₹${price} per pack.`;
    return storeProposal(
      db,
      person,
      action,
      { officeId: office.id, productId: product.id, date, packs, pricePerPack: price },
      summary,
      office.id,
    );
  }
  requireWrite(person, office.id);
  const date = parseDate(payload.date || todayInIndia(now()));
  const packs = parsePacks(payload.packs, { allowZero: true });
  const summary = `Count ${packs} packs of ${product.name} on the shelf at ${office.name} on ${date}.`;
  return storeProposal(
    db,
    person,
    action,
    { officeId: office.id, productId: product.id, date, packs },
    summary,
    office.id,
  );
}

function proposeRowDelete(db, person, office, product, payload, kind) {
  const purchase = kind === "purchase";
  let rows = purchase
    ? db
        .prepare(
          "SELECT * FROM pantry_purchase WHERE product_id = ? AND deleted_at IS NULL ORDER BY purchased_on, created_at",
        )
        .all(product.id)
    : db
        .prepare(
          "SELECT * FROM pantry_count WHERE product_id = ? AND deleted_at IS NULL ORDER BY counted_on, created_at",
        )
        .all(product.id);
  const rowId = purchase ? payload.purchaseId : payload.countId;
  if (rowId) rows = rows.filter((row) => row.id === rowId);
  if (payload.date) rows = rows.filter((row) => (purchase ? row.purchased_on : row.counted_on) === payload.date);
  if (payload.packs != null && payload.packs !== "") {
    rows = rows.filter((row) => Number(row.packs) === Number(payload.packs));
  }
  const label = purchase ? "purchase" : "shelf count";
  if (rows.length !== 1) {
    if (!rows.length) throw new HttpError(422, `There is no matching ${label} of ${product.name} at ${office.name}.`);
    const sample = rows
      .slice(0, 6)
      .map((row) => `${row.packs} packs on ${purchase ? row.purchased_on : row.counted_on}`)
      .join("; ");
    const more = rows.length > 6 ? `; and ${rows.length - 6} more` : "";
    throw new HttpError(422, `Which ${label} of ${product.name}: ${sample}${more}?`);
  }
  const row = rows[0];
  const summary = purchase
    ? `The purchase of ${row.packs} packs of ${product.name} at ${office.name} on ${row.purchased_on}.`
    : `The shelf count of ${row.packs} packs of ${product.name} at ${office.name} on ${row.counted_on}.`;
  const stored = purchase
    ? { officeId: office.id, purchaseId: row.id }
    : { officeId: office.id, countId: row.id };
  return storeProposal(db, person, purchase ? "delete_purchase" : "delete_count", stored, summary, office.id);
}

function storeProposal(db, person, action, payload, summary, officeId) {
  const proposalId = id();
  db.prepare(
    `INSERT INTO proposal (id, person_id, action, payload, summary, office_id, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(proposalId, person.id, action, JSON.stringify(payload), summary, officeId, stamp());
  return { proposalId, summary, status: "pending_confirmation", action };
}

export function confirmProposal(db, person, proposalId) {
  const proposal = db.prepare("SELECT * FROM proposal WHERE id = ? AND person_id = ?").get(proposalId, person.id);
  if (!proposal || proposal.status !== "pending") throw new HttpError(404, "That confirmation is no longer waiting.");
  if (!PROPOSALS.has(proposal.action)) throw new HttpError(403, "The assistant cannot hide, delete, restore, or correct a record.");
  const payload = JSON.parse(proposal.payload);
  let result;
  if (proposal.action === "create_product") result = createProduct(db, person, payload.officeId, payload.name);
  if (proposal.action === "add_purchase") result = createPurchase(db, person, payload.officeId, payload);
  if (proposal.action === "add_count") result = upsertCount(db, person, payload.officeId, payload);
  if (proposal.action === "delete_product") result = deleteProduct(db, person, payload.productId);
  if (proposal.action === "delete_purchase") result = deletePurchase(db, person, payload.purchaseId);
  if (proposal.action === "delete_count") result = deleteCount(db, person, payload.countId);
  db.prepare("UPDATE proposal SET status = 'confirmed' WHERE id = ?").run(proposalId);
  return { ok: true, summary: proposal.summary, result, action: proposal.action };
}

export function dismissProposal(db, person, proposalId) {
  const proposal = db.prepare("SELECT * FROM proposal WHERE id = ? AND person_id = ?").get(proposalId, person.id);
  if (!proposal || proposal.status !== "pending") throw new HttpError(404, "That confirmation is no longer waiting.");
  db.prepare("UPDATE proposal SET status = 'dismissed' WHERE id = ?").run(proposalId);
  return { ok: true };
}

export function listChatThreads(db, person) {
  return db
    .prepare("SELECT * FROM chat_thread WHERE person_id = ? ORDER BY updated_at DESC LIMIT 40")
    .all(person.id)
    .map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      updatedAtLabel: formatWhen(row.updated_at),
    }));
}

export function createChatThread(db, person) {
  const threadId = id();
  const at = stamp();
  db.prepare(
    "INSERT INTO chat_thread (id, person_id, title, created_at, updated_at) VALUES (?, ?, 'New chat', ?, ?)",
  ).run(threadId, person.id, at, at);
  return { id: threadId, title: "New chat", updatedAt: at, updatedAtLabel: formatWhen(at) };
}

function threadFor(db, person, threadId) {
  const thread = db.prepare("SELECT * FROM chat_thread WHERE id = ? AND person_id = ?").get(threadId, person.id);
  if (!thread) throw new HttpError(404, "That chat was not found.");
  return thread;
}

export function getChatThread(db, person, threadId) {
  const thread = threadFor(db, person, threadId);
  const messages = db
    .prepare("SELECT * FROM chat_message WHERE thread_id = ? ORDER BY created_at, rowid")
    .all(threadId)
    .map((row) => {
      const proposals = JSON.parse(row.proposals || "[]")
        .map((proposal) => {
          const live = db.prepare("SELECT status FROM proposal WHERE id = ?").get(proposal.id);
          return live?.status === "pending" ? proposal : null;
        })
        .filter(Boolean);
      return { id: row.id, role: row.role, content: row.content, proposals };
    });
  return {
    thread: { id: thread.id, title: thread.title, updatedAtLabel: formatWhen(thread.updated_at) },
    messages,
  };
}

export function recentChatHistory(db, person, threadId) {
  threadFor(db, person, threadId);
  return db
    .prepare(
      "SELECT role, content FROM chat_message WHERE thread_id = ? AND role IN ('user', 'assistant') ORDER BY created_at DESC, rowid DESC LIMIT 10",
    )
    .all(threadId)
    .reverse();
}

export function addChatMessage(db, person, threadId, role, content, proposals = []) {
  const thread = threadFor(db, person, threadId);
  const at = stamp();
  const messageId = id();
  db.prepare(
    "INSERT INTO chat_message (id, thread_id, role, content, proposals, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(messageId, threadId, role, content, JSON.stringify(proposals), at);
  const title =
    thread.title === "New chat" && role === "user"
      ? String(content).replace(/\s+/g, " ").trim().slice(0, 48) || "New chat"
      : thread.title;
  db.prepare("UPDATE chat_thread SET title = ?, updated_at = ? WHERE id = ?").run(title, at, threadId);
  return { id: messageId, role, content, proposals };
}

export function latestPending(db, personId) {
  return db
    .prepare(
      `SELECT * FROM proposal WHERE person_id = ? AND status = 'pending' ORDER BY created_at DESC`,
    )
    .all(personId);
}

export function resolveOffice(db, person, nameOrId) {
  const offices = listOffices(db, person);
  const query = String(nameOrId || "").trim().toLowerCase();
  if (!query && offices.length === 1) return offices[0];
  const matches = offices.filter(
    (office) => office.id === nameOrId || office.name.toLowerCase() === query || office.name.toLowerCase().includes(query),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new HttpError(404, "Office not found.");
  throw new HttpError(422, `Which office: ${matches.map((office) => office.name).join(", ")}?`);
}

function resolveProduct(db, officeId, nameOrId) {
  const products = db
    .prepare("SELECT * FROM pantry_product WHERE office_id = ? AND deleted_at IS NULL")
    .all(officeId);
  const query = String(nameOrId || "").trim().toLowerCase();
  const matches = products.filter(
    (product) => product.id === nameOrId || product.name.toLowerCase() === query,
  );
  if (matches.length === 1) return matches[0];
  throw new HttpError(
    422,
    `Which product at this office: ${products.map((product) => product.name).join(", ")}?`,
  );
}

export function snapshotForChat(db, person) {
  const offices = listOffices(db, person);
  const lines = offices.map((office) => {
    const names = db
      .prepare("SELECT name FROM pantry_product WHERE office_id = ? AND deleted_at IS NULL ORDER BY name")
      .all(office.id)
      .map((row) => row.name);
    return `${office.name}: ${names.join(", ") || "no products"}`;
  });
  const role = person.superAdmin
    ? "Super Admin"
    : person.grants.map((grant) => `${grant.role} at ${grant.officeName}`).join("; ");
  return { role, lines, canWriteSomewhere: person.superAdmin || person.grants.some((grant) => grant.role === "office_manager") };
}

function insertPerson(db, email, displayName) {
  const personId = id();
  db.prepare(
    `INSERT INTO person (id, directory_object_id, sign_in_name, display_name, active)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(personId, `local:${email.toLowerCase()}`, email, displayName);
  return personId;
}

function grant(db, actorId, personId, role, officeId) {
  if (!ROLES.has(role)) throw new Error("bad role");
  db.prepare(
    `INSERT INTO role_grant (id, person_id, role, office_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id(), personId, role, officeId, actorId, stamp());
}

function seedProduction(db) {
  const signInName = intuitiveSignInName(process.env.SEED_SUPERADMIN_EMAIL || "Siddharth.Kalyani@intuitive.AI");
  if (!signInName) throw new Error("SEED_SUPERADMIN_EMAIL must be an @intuitive.AI sign-in name.");
  const displayName = cleanName(process.env.SEED_SUPERADMIN_NAME || "Siddharth Kalyani") || "Siddharth Kalyani";
  const configuredOid = String(process.env.SEED_SUPERADMIN_OBJECT_ID || "").trim();
  const oid = configuredOid ? configuredOid : null;
  if (oid && !OBJECT_ID.test(oid)) throw new Error("SEED_SUPERADMIN_OBJECT_ID must be a directory object id.");
  let person = db.prepare("SELECT * FROM person WHERE sign_in_name = ? COLLATE NOCASE").get(signInName);
  if (!person && oid) person = db.prepare("SELECT * FROM person WHERE directory_object_id = ?").get(oid);
  if (!person) {
    const personId = id();
    db.prepare(
      `INSERT INTO person (id, directory_object_id, sign_in_name, display_name, active)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(personId, oid, signInName, displayName);
    person = personById(db, personId);
  } else if (oid && !person.directory_object_id) {
    db.prepare("UPDATE person SET directory_object_id = ? WHERE id = ? AND directory_object_id IS NULL").run(oid, person.id);
  }
  const existing = db
    .prepare(
      `SELECT id FROM role_grant WHERE person_id = ? AND role = 'super_admin' AND deleted_at IS NULL`,
    )
    .get(person.id);
  if (!existing) grant(db, person.id, person.id, "super_admin", null);
}

function seed(db) {
  const saved = clock;
  const at = (iso) => {
    clock = () => new Date(iso);
  };
  at("2026-07-01T04:30:00.000Z");
  const avery = insertPerson(db, "avery.shah@intuitive.AI", "Avery Shah");
  const meera = insertPerson(db, "meera.patel@intuitive.AI", "Meera Patel");
  const rohan = insertPerson(db, "rohan.desai@intuitive.AI", "Rohan Desai");
  const isha = insertPerson(db, "isha.rao@intuitive.AI", "Isha Rao");
  const kabir = insertPerson(db, "kabir.mehta@intuitive.AI", "Kabir Mehta");
  grant(db, avery, avery, "super_admin", null);
  const averyPerson = presentPerson(db, personById(db, avery));
  const ahmedabad = createOffice(db, averyPerson, "Ahmedabad");
  const pune = createOffice(db, averyPerson, "Pune");
  db.prepare("UPDATE person SET home_office_id = ? WHERE id = ?").run(ahmedabad.id, avery);
  db.prepare("UPDATE person SET home_office_id = ? WHERE id = ?").run(ahmedabad.id, meera);
  db.prepare("UPDATE person SET home_office_id = ? WHERE id = ?").run(pune.id, rohan);
  db.prepare("UPDATE person SET home_office_id = ? WHERE id = ?").run(ahmedabad.id, isha);
  db.prepare("UPDATE person SET home_office_id = ? WHERE id = ?").run(ahmedabad.id, kabir);
  grant(db, avery, meera, "office_manager", ahmedabad.id);
  grant(db, avery, rohan, "office_manager", pune.id);
  grant(db, avery, isha, "admin", ahmedabad.id);
  grant(db, avery, kabir, "accounts", ahmedabad.id);
  grant(db, avery, kabir, "accounts", pune.id);

  clock = saved;
}

const DEMO_PURCHASES = [
  ["Ahmedabad", "Coffee", "2026-07-15", 20, "180.00"],
  ["Ahmedabad", "Coffee", "2026-08-12", 20, "200.00"],
  ["Ahmedabad", "Coffee", "2026-09-08", 10, "205.00"],
  ["Ahmedabad", "Milk", "2026-07-08", 24, "55.00"],
  ["Ahmedabad", "Milk", "2026-08-11", 26, "58.00"],
  ["Ahmedabad", "Milk", "2026-09-04", 6, "60.00"],
  ["Ahmedabad", "Sugar", "2026-07-09", 10, "42.00"],
  ["Ahmedabad", "Sugar", "2026-08-13", 12, "44.00"],
  ["Ahmedabad", "Sugar", "2026-09-07", 4, "45.00"],
  ["Ahmedabad", "Tea", "2026-07-16", 14, "85.00"],
  ["Ahmedabad", "Tea", "2026-08-18", 16, "88.00"],
  ["Ahmedabad", "Tea", "2026-09-09", 6, "90.00"],
  ["Ahmedabad", "Sticks", "2026-07-21", 18, "20.00"],
  ["Ahmedabad", "Sticks", "2026-08-19", 16, "22.00"],
  ["Ahmedabad", "Sticks", "2026-09-11", 8, "22.00"],
  ["Pune", "Coffee", "2026-07-07", 12, "190.00"],
  ["Pune", "Coffee", "2026-08-06", 14, "195.00"],
  ["Pune", "Coffee", "2026-09-05", 6, "198.00"],
  ["Pune", "Milk", "2026-07-10", 18, "54.00"],
  ["Pune", "Milk", "2026-08-14", 16, "56.00"],
  ["Pune", "Milk", "2026-09-06", 8, "57.00"],
  ["Pune", "Sugar", "2026-07-17", 6, "40.00"],
  ["Pune", "Sugar", "2026-08-20", 8, "42.00"],
  ["Pune", "Sugar", "2026-09-08", 3, "43.00"],
  ["Pune", "Tea", "2026-07-13", 8, "86.00"],
  ["Pune", "Tea", "2026-08-17", 8, "90.00"],
  ["Pune", "Tea", "2026-09-10", 4, "90.00"],
  ["Pune", "Sticks", "2026-07-24", 10, "18.00"],
  ["Pune", "Sticks", "2026-08-26", 10, "18.00"],
  ["Pune", "Sticks", "2026-09-12", 4, "18.00"],
];

const DEMO_COUNTS = [
  ["Ahmedabad", "Coffee", "2026-09-20", 6],
  ["Ahmedabad", "Milk", "2026-09-18", 14],
  ["Ahmedabad", "Sugar", "2026-09-18", 8],
  ["Ahmedabad", "Tea", "2026-09-18", 12],
  ["Ahmedabad", "Sticks", "2026-09-18", 4],
  ["Pune", "Coffee", "2026-09-18", 8],
  ["Pune", "Milk", "2026-09-18", 10],
  ["Pune", "Sugar", "2026-09-18", 6],
  ["Pune", "Tea", "2026-09-18", 5],
  ["Pune", "Sticks", "2026-09-18", 7],
];

function applyDemoHistory(db) {
  const meera = db.prepare("SELECT * FROM person WHERE sign_in_name = 'meera.patel@intuitive.AI'").get();
  const rohan = db.prepare("SELECT * FROM person WHERE sign_in_name = 'rohan.desai@intuitive.AI'").get();
  if (!meera || !rohan) return;
  const actors = {
    Ahmedabad: presentPerson(db, meera),
    Pune: presentPerson(db, rohan),
  };
  const saved = clock;
  try {
    for (const [officeName, productName, date, packs, price] of DEMO_PURCHASES) {
      const office = db.prepare("SELECT id FROM office WHERE name = ?").get(officeName);
      if (!office) continue;
      const product = db
        .prepare("SELECT id FROM pantry_product WHERE office_id = ? AND name = ? AND deleted_at IS NULL")
        .get(office.id, productName);
      if (!product) continue;
      const existing = db
        .prepare(
          `SELECT id FROM pantry_purchase
           WHERE product_id = ? AND purchased_on = ? AND packs = ? AND price_per_pack = ? AND deleted_at IS NULL`,
        )
        .get(product.id, date, packs, price);
      if (existing) continue;
      clock = () => new Date(`${date}T05:00:00.000Z`);
      createPurchase(db, actors[officeName], office.id, {
        productId: product.id,
        date,
        packs,
        pricePerPack: price,
      });
    }
    for (const [officeName, productName, date, packs] of DEMO_COUNTS) {
      const office = db.prepare("SELECT id FROM office WHERE name = ?").get(officeName);
      if (!office) continue;
      const product = db
        .prepare("SELECT id FROM pantry_product WHERE office_id = ? AND name = ? AND deleted_at IS NULL")
        .get(office.id, productName);
      if (!product) continue;
      const existing = db
        .prepare(
          "SELECT id FROM pantry_count WHERE product_id = ? AND counted_on = ? AND deleted_at IS NULL",
        )
        .get(product.id, date);
      if (existing) continue;
      clock = () => new Date(`${date}T04:30:00.000Z`);
      upsertCount(db, actors[officeName], office.id, { productId: product.id, date, packs });
    }
  } finally {
    clock = saved;
  }
}
