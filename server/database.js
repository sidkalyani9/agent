import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Only repository-owned SQL reaches this translator. Values remain parameters.
export function postgresSql(sql) {
  const pragma = /^PRAGMA table_info\((\w+)\)$/i.exec(sql.trim());
  if (pragma) return `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${pragma[1]}'`;
  let normalized = sql
    .replace(/\bifnull\(/gi, "coalesce(")
    .replace(/([\w.]+) = \? COLLATE NOCASE/gi, "lower($1) = lower(?)")
    .replace(/name COLLATE NOCASE/gi, "lower(name)")
    .replace(/ COLLATE NOCASE/gi, "")
    .replace(/BEGIN IMMEDIATE/g, "BEGIN")
    .replace(/CREATE TABLE IF NOT EXISTS chat_message \(/, "CREATE TABLE IF NOT EXISTS chat_message (sequence BIGSERIAL UNIQUE,")
    .replace(/\browid\b/g, "sequence")
    .replace(/coalesce\(office_id, ''\)/g, "(coalesce(office_id, ''))");
  let index = 0, quoted = false, out = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === "'" && quoted && normalized[i + 1] === "'") { out += "''"; i++; continue; }
    if (c === "'") quoted = !quoted;
    out += c === "?" && !quoted ? `$${++index}` : c;
  }
  return out;
}

export function createDatabase(file, { pool } = {}) {
  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  // An explicit filename always means SQLite, keeping tests off live databases.
  const connectionString = file ? "" : process.env.DATABASE_URL;
  const postgres = Boolean(pool || connectionString);
  if (connectionString && !pool) {
    let url;
    try { url = new URL(connectionString); } catch { throw new Error("DATABASE_URL is not a valid PostgreSQL connection URL."); }
    // Do not let connection-string flags silently turn certificate checks off.
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
    pool = new pg.Pool({ connectionString: url.href, max: 5, connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000, statement_timeout: 15000,
      ssl: process.env.NODE_ENV === "production" || process.env.PGSSL !== "disable" ? { rejectUnauthorized: true } : false });
    pool.on("error", () => console.error("Database connection failed."));
  }
  let sqlite;
  if (!postgres) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqlite = new DatabaseSync(file);
    sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL");
  }
  const query = async (sql, params = []) => {
    const client = context.getStore()?.client || pool;
    const result = await client.query(postgresSql(sql), params);
    for (const row of result.rows || []) if (typeof row.n === "string" && /^\d+$/.test(row.n)) row.n = Number(row.n);
    return result;
  };
  const db = {
    dialect: postgres ? "postgres" : "sqlite",
    prepare(sql) {
      if (sqlite) return sqlite.prepare(sql);
      return {
        async get(...params) { return (await query(sql, params)).rows[0]; },
        async all(...params) { return (await query(sql, params)).rows; },
        async run(...params) { const result = await query(sql, params); return { changes: result.rowCount }; },
      };
    },
    async exec(sql) {
      const state = context.getStore();
      let actual = sql;
      let depth = state?.depth || 0;
      const command = sql.trim().toUpperCase();
      if (state && /^BEGIN(?: IMMEDIATE)?$/.test(command)) {
        actual = depth ? `SAVEPOINT pantry_tx_${depth}` : sql;
        depth++;
      } else if (state && depth && command === "COMMIT") {
        depth--; actual = depth ? `RELEASE SAVEPOINT pantry_tx_${depth}` : "COMMIT";
      } else if (state && depth && command === "ROLLBACK") {
        depth--; actual = depth ? `ROLLBACK TO SAVEPOINT pantry_tx_${depth}; RELEASE SAVEPOINT pantry_tx_${depth}` : "ROLLBACK";
      }
      if (sqlite) { sqlite.exec(actual); if (state) state.depth = depth; return; }
      if (/^PRAGMA (?!table_info)/i.test(sql)) return;
      const result = await query(actual);
      if (state) state.depth = depth;
      return result;
    },
    async transaction(callback) {
      return db.scope(async () => {
        await db.exec("BEGIN");
        try { const result = await callback(); await db.exec("COMMIT"); return result; }
        catch (error) { await db.exec("ROLLBACK"); throw error; }
      });
    },
    async scope(callback) {
      if (context.getStore()) return callback();
      // Preserve the app's single-writer semantics across await points and app
      // instances. At 10–20 users this is deliberately simpler than fine-grained
      // locks. No scope is held while awaiting an AI or Microsoft response.
      if (sqlite) {
        const previous = queue;
        let release;
        queue = new Promise(resolve => { release = resolve; });
        await previous;
        const state = { depth: 0 };
        try { return await context.run(state, callback); }
        finally { try { if (state.depth) sqlite.exec("ROLLBACK"); } finally { release(); } }
      }
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(206092701)");
        return await context.run({ client }, callback);
      } finally {
        let cleanupError;
        try { await client.query("ROLLBACK"); await client.query("SELECT pg_advisory_unlock(206092701)"); }
        catch (error) { cleanupError = error; throw error; }
        finally { client.release(cleanupError); }
      }
    },
    async close() { if (sqlite) sqlite.close(); else await pool.end(); },
  };
  return db;
}
