import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { storeReceipt, readReceipt, safeBlobName } from "./receipts.js";

const TABLES = ["person", "office", "role_grant", "company_setting", "pantry_product", "pantry_purchase", "pantry_count", "pantry_receipt", "operation", "chat_thread", "chat_message", "idempotency"];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function inspectMigration(sourceFile, receiptDirectory) {
  if (!fs.existsSync(sourceFile)) throw new Error("Source database does not exist.");
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    source.exec("BEGIN");
    if (source.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Source database failed its integrity check.");
    const rows = Object.fromEntries(TABLES.map(table => [table, source.prepare(`SELECT * FROM ${table}${table === "chat_message" ? " ORDER BY rowid" : ""}`).all()]));
    if (rows.person.some(p => String(p.directory_object_id || "").startsWith("local:"))) throw new Error("Demo fixture people cannot be migrated to production.");
    const receipts = rows.pantry_receipt.map(row => {
      const sourcePath = path.join(receiptDirectory, safeBlobName(row.blob_path));
      if (!fs.existsSync(sourcePath)) throw new Error("A referenced receipt is missing. Repair the backup before migrating.");
      const bytes = fs.readFileSync(sourcePath);
      if (bytes.length !== row.byte_size) throw new Error("A receipt size does not match its database record.");
      const extension = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[row.content_type];
      if (!extension) throw new Error("A receipt has an unsupported type.");
      const name = `legacy-${row.purchase_id}-${digest(bytes).slice(0, 32)}.${extension}`;
      row.blob_path = name;
      return { name, bytes, contentType: row.content_type };
    });
    return { rows, receipts, counts: Object.fromEntries(TABLES.map(table => [table, rows[table].length])) };
  } finally { source.close(); }
}

async function uploadOnce(receipt) {
  try { await storeReceipt(receipt.name, receipt.bytes, receipt.contentType); }
  catch (error) {
    if (error.statusCode !== 409 && error.statusCode !== 412 && error.code !== "EEXIST") throw error;
    const stream = await readReceipt(receipt.name);
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    if (digest(Buffer.concat(chunks)) !== digest(receipt.bytes)) throw new Error("A target receipt conflicts with the source. Nothing was overwritten.");
  }
}

export async function migrateSnapshot(target, snapshot, { upload = uploadOnce } = {}) {
  if (target.dialect !== "postgres") throw new Error("Migration target must be PostgreSQL.");
  return target.scope(async () => {
    for (const table of TABLES.filter(name => name !== "company_setting")) {
      if (await target.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get()) throw new Error("Target is not empty. Migration will not overwrite existing data.");
    }
    // Upload immutable objects before the database commit. If the DB rolls
    // back, only unreferenced objects remain; retry verifies their checksums.
    for (const receipt of snapshot.receipts) await upload(receipt);
    await target.exec("BEGIN");
    try {
      await target.exec("DELETE FROM company_setting");
      for (const table of TABLES) {
        const allowed = new Set((await target.prepare(`PRAGMA table_info(${table})`).all()).map(c => c.name));
        for (const row of snapshot.rows[table]) {
          const columns = Object.keys(row).filter(c => allowed.has(c) && c !== "sequence");
          if (!columns.every(c => /^[a-z_]+$/.test(c))) throw new Error("Invalid source schema.");
          await target.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map(c => row[c]));
        }
        const count = (await target.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n;
        if (count !== snapshot.counts[table]) throw new Error("Migration row-count verification failed.");
      }
      await target.exec("COMMIT");
      return snapshot.counts;
    } catch (error) { await target.exec("ROLLBACK"); throw error; }
  });
}
