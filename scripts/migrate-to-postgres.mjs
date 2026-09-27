import path from "node:path";
import { inspectMigration, migrateSnapshot } from "../server/migration.js";
import { openDatabase } from "../server/service.js";

const [sourceFile, receiptDirectory, flag] = process.argv.slice(2);
if (!sourceFile || !receiptDirectory || (flag && flag !== "--execute")) {
  console.error("Usage: node scripts/migrate-to-postgres.mjs /absolute/backup.sqlite /absolute/receipts [--execute]");
  process.exit(1);
}
if (!path.isAbsolute(sourceFile) || !path.isAbsolute(receiptDirectory)) throw new Error("Use absolute paths to the reviewed backup.");
let target;
try {
  const snapshot = inspectMigration(sourceFile, receiptDirectory);
  console.log(JSON.stringify({ mode: flag ? "execute" : "check", counts: snapshot.counts, receipts: snapshot.receipts.length }));
  if (flag) {
    if (!process.env.DATABASE_URL || !process.env.AZURE_STORAGE_ACCOUNT_URL) throw new Error("Execution requires the target DATABASE_URL and AZURE_STORAGE_ACCOUNT_URL.");
    target = await openDatabase(null, { seed: "none" });
    await migrateSnapshot(target, snapshot);
    console.log("Migration verified. Sessions and pending chat confirmations were not copied; everyone must sign in again.");
  } else console.log("Source checked. No target was connected and no data was changed. Stop source writes, then use --execute for the final migration.");
} catch (error) {
  // Driver errors can include SQL parameters, passwords, or connection URLs.
  console.error("Migration failed. The source was not modified. Check connectivity, permissions, source integrity, and that the target is empty.");
  process.exitCode = 1;
} finally { if (target) await target.close(); }
