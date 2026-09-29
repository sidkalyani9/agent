"""Explicit, source-preserving SQLite → empty PostgreSQL migration."""
import argparse
import asyncio
import hashlib
import json
import os
import re
import sqlite3
import sys
from pathlib import Path
from .receipts import store_receipt, read_receipt, safe_blob_name

TABLES = ["person", "office", "role_grant", "company_setting", "pantry_product", "pantry_purchase", "pantry_count", "pantry_receipt", "operation", "chat_thread", "chat_message", "idempotency"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect_migration(source_file, receipt_directory):
    source_file, receipt_directory = Path(source_file), Path(receipt_directory)
    if not source_file.exists():
        raise ValueError("Source database does not exist.")
    source = sqlite3.connect(source_file.resolve().as_uri() + "?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    try:
        source.execute("BEGIN")
        if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Source database failed its integrity check.")
        rows = {table: [dict(r) for r in source.execute(f"SELECT * FROM {table}" + (" ORDER BY rowid" if table == "chat_message" else ""))] for table in TABLES}
        if any(str(p.get("directory_object_id") or "").startswith("local:") for p in rows["person"]):
            raise ValueError("Demo fixture people cannot be migrated to production.")
        receipts = []
        for row in rows["pantry_receipt"]:
            path = receipt_directory / safe_blob_name(row["blob_path"])
            if not path.exists():
                raise ValueError("A referenced receipt is missing. Repair the backup before migrating.")
            data = path.read_bytes()
            if len(data) != row["byte_size"]:
                raise ValueError("A receipt size does not match its database record.")
            extension = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png"}.get(row["content_type"])
            if not extension:
                raise ValueError("A receipt has an unsupported type.")
            name = f"legacy-{row['purchase_id']}-{digest(data)[:32]}.{extension}"
            row["blob_path"] = name
            receipts.append({"name": name, "bytes": data, "contentType": row["content_type"]})
        return {"rows": rows, "receipts": receipts, "counts": {table: len(rows[table]) for table in TABLES}}
    finally:
        source.close()


async def upload_once(receipt):
    try:
        await store_receipt(receipt["name"], receipt["bytes"], receipt["contentType"])
    except Exception as error:
        if not isinstance(error, FileExistsError) and getattr(error, "status_code", None) not in (409, 412):
            raise
        if digest(await read_receipt(receipt["name"])) != digest(receipt["bytes"]):
            raise ValueError("A target receipt conflicts with the source. Nothing was overwritten.") from None


async def migrate_snapshot(target, snapshot, *, upload=upload_once):
    if target.dialect != "postgres":
        raise ValueError("Migration target must be PostgreSQL.")
    async with target.scope():
        for table in TABLES:
            if table != "company_setting" and await target.get(f"SELECT 1 AS present FROM {table} LIMIT 1"):
                raise ValueError("Target is not empty. Migration will not overwrite existing data.")
        for receipt in snapshot["receipts"]:
            await upload(receipt)
        async with target.transaction():
            await target.run("DELETE FROM company_setting")
            for table in TABLES:
                allowed = {c["name"] for c in await target.all(f"PRAGMA table_info({table})")}
                for row in snapshot["rows"][table]:
                    columns = [c for c in row if c in allowed and c != "sequence"]
                    if not all(re.fullmatch(r"[a-z_]+", c) for c in columns):
                        raise ValueError("Invalid source schema.")
                    await target.run(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", *(row[c] for c in columns))
                count = (await target.get(f"SELECT count(*) AS n FROM {table}"))["n"]
                if count != snapshot["counts"][table]:
                    raise ValueError("Migration row-count verification failed.")
        return snapshot["counts"]


async def run(args):
    from .core import open_database
    target = None
    try:
        if not Path(args.source).is_absolute() or not Path(args.receipts).is_absolute():
            raise ValueError("Use absolute paths to the reviewed backup.")
        snapshot = inspect_migration(args.source, args.receipts)
        print(json.dumps({"mode": "execute" if args.execute else "check", "counts": snapshot["counts"], "receipts": len(snapshot["receipts"])}))
        if args.execute:
            if not os.getenv("DATABASE_URL") or not os.getenv("AZURE_STORAGE_ACCOUNT_URL"):
                raise ValueError("Execution requires the target DATABASE_URL and AZURE_STORAGE_ACCOUNT_URL.")
            target = await open_database(seed="none")
            await migrate_snapshot(target, snapshot)
            print("Migration verified. Sessions and pending chat confirmations were not copied; everyone must sign in again.")
        else:
            print("Source checked. No target was connected and no data was changed. Stop source writes, then use --execute for the final migration.")
        return 0
    except Exception:
        print("Migration failed. The source was not modified. Check connectivity, permissions, source integrity, and that the target is empty.", file=sys.stderr)
        return 1
    finally:
        if target:
            await target.close()


def main():
    # Deliberately does not load .env or infer permission to migrate live data.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Absolute path to reviewed SQLite backup")
    parser.add_argument("receipts", help="Absolute path to reviewed receipt backup")
    parser.add_argument("--execute", action="store_true")
    raise SystemExit(asyncio.run(run(parser.parse_args())))


if __name__ == "__main__":
    main()
