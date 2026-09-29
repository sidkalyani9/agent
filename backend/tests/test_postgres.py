import asyncio
import copy
from pathlib import Path
import pytest
from pantry import core as c, accounts as a, inventory as i, conversations as conv, migration as m
from pantry.database import Database, postgres_sql
from .test_accounts import fails, choose_password
from .test_node_contracts import CORPUS, normalize

pytestmark = pytest.mark.postgres


async def test_postgres_complete_node_service_contract(postgres_database):
    import re
    db = await postgres_database()
    async with db.transaction():
        await db.run("DELETE FROM company_setting")
        for table, rows in CORPUS["rows"].items():
            for row in rows:
                await db.run(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})", *row.values())
    variables = copy.deepcopy(CORPUS["vars"])
    def resolve(value):
        if isinstance(value, str) and value.startswith("$"):
            result = variables
            for key in value[1:].split("."):
                result = result[int(key)] if isinstance(result, list) else result[key]
            return result
        if isinstance(value, list):
            return [resolve(v) for v in value]
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        return value
    for index, step in enumerate(CORPUS["steps"]):
        name = re.sub(r"(?<!^)(?=[A-Z])", "_", step["call"]).lower()
        fn = next(getattr(module, name) for module in (a, i, conv) if hasattr(module, name))
        try:
            result = await fn(db, variables[step["actor"]], *resolve(step["args"]))
            if step.get("save"):
                variables[step["save"]] = result
            actual = {"ok": normalize(result)}
        except c.HttpError as error:
            actual = {"error": {"status": error.status, "message": error.message}}
        # PostgreSQL does not promise a tie order for equal audit timestamps.
        # Compare the same operation rows as a multiset in this one case.
        expected = step["expected"]
        if name == "list_operations" and "ok" in actual:
            sort = lambda rows: sorted(rows, key=lambda r: (r["at"], r["summary"], r["action"]))
            actual, expected = {"ok": sort(actual["ok"])}, {"ok": sort(expected["ok"])}
        assert actual == expected, f"PostgreSQL Node contract {index}: {step['call']}"


async def test_postgres_concurrent_refresh_cross_connection_and_receipt_rollback(postgres_database, monkeypatch):
    db = await postgres_database("fixtures")
    second = await postgres_database("none")
    admin = (await a.sign_in(db, "avery.shah@intuitive.AI"))["person"]
    session = await a.begin_browser_session(db, admin["id"])
    results = await asyncio.gather(a.rotate_refresh(db, session["refreshToken"]), a.rotate_refresh(second, session["refreshToken"]), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1
    issued = next(r for r in results if isinstance(r, dict))
    assert await a.person_from_access_token(second, issued["accessToken"]) is None
    office = (await i.list_offices(db, admin))[0]["id"]
    product = (await i.get_pantry(db, admin, office))["products"][0]["productId"]
    await db.exec("""CREATE FUNCTION fail_receipt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'receipt.%' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$""")
    await db.exec("CREATE TRIGGER receipt_audit_failure BEFORE INSERT ON operation FOR EACH ROW EXECUTE FUNCTION fail_receipt_audit()")
    saved = await i.create_purchase(db, admin, office, {"productId": product, "date": "2026-09-20", "packs": 2, "pricePerPack": "10"}, {"fileName": "r.pdf", "bytes": b"%PDF-1.4\npostgres"})
    assert not saved["receiptSaved"] and await db.get("SELECT id FROM pantry_purchase WHERE id = ?", saved["purchaseId"])
    assert not await db.get("SELECT purchase_id FROM pantry_receipt WHERE purchase_id = ?", saved["purchaseId"])
    await db.exec("DROP TRIGGER receipt_audit_failure ON operation")
    assert (await i.attach_receipt(db, admin, saved["purchaseId"], {"fileName": "r.pdf", "bytes": b"%PDF-1.4\npostgres"}))["receiptSaved"]


async def test_migration_preserves_source_passwords_receipts_and_rolls_back(tmp_path, postgres_database):
    file = tmp_path / "source.sqlite"
    source = await c.open_database(file, seed="production")
    try:
        admin = (await a.sign_in(source, "Siddharth.Kalyani@intuitive.AI"))["person"]
        await choose_password(source, admin, admin["email"])
        office = await i.create_office(source, admin, "Migration office")
        product = await i.create_product(source, admin, office["id"], "Biscuits")
        saved = await i.create_purchase(source, admin, office["id"], {"productId": product["productId"], "date": "2026-09-20", "packs": 3, "pricePerPack": "12.50"}, {"fileName": "migration.pdf", "bytes": b"%PDF-1.4\nmigration\n%%EOF"})
        assert saved["receiptSaved"]
        pending = await conv.create_proposal(source, admin, "create_product", {"office": "Migration office", "name": "Not copied"})
        before = await source.all("SELECT * FROM pantry_receipt")
        from pantry.config import data_directory
        snapshot = m.inspect_migration(file, data_directory() / "receipts")
        assert len(snapshot["receipts"]) == 1
        assert snapshot["rows"]["pantry_receipt"][0]["blob_path"].startswith("legacy-")
        target = await postgres_database()
        broken = copy.deepcopy(snapshot)
        broken["rows"]["person"].append(broken["rows"]["person"][0])
        with pytest.raises(Exception):
            await m.migrate_snapshot(target, broken)
        assert (await target.get("SELECT count(*) AS n FROM person"))["n"] == 0
        assert await m.migrate_snapshot(target, snapshot) == snapshot["counts"]
        assert await source.all("SELECT * FROM pantry_receipt") == before
        assert (await i.get_pantry(target, admin, office["id"], "2026-09"))["spend"] == "37.50"
        for table in ("refresh_token", "session", "setup_ticket", "login_attempt", "proposal"):
            assert (await target.get(f"SELECT count(*) AS n FROM {table}"))["n"] == 0
        assert (await a.login_with_password(target, admin["email"], "Pantry Door 19"))["next"] == "app"
        assert (await i.receipt_file(target, admin, saved["purchaseId"]))["bytes"] == snapshot["receipts"][0]["bytes"]
        with pytest.raises(ValueError, match="not empty"):
            await m.migrate_snapshot(target, snapshot)
    finally:
        await source.close()


def test_postgres_translation_and_production_tls(monkeypatch):
    assert postgres_sql("SELECT '?' AS literal, ? AS value") == "SELECT '?' AS literal, %s AS value"
    assert postgres_sql("SELECT 'it''s ?' AS literal, ? AS value") == "SELECT 'it''s ?' AS literal, %s AS value"
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("PGSSL", "disable")
    db = Database(url="postgresql://user:synthetic@localhost/test?sslmode=disable&sslrootcert=bad")
    assert "sslmode=verify-full" in db.pool.conninfo and "sslrootcert=bad" not in db.pool.conninfo
    monkeypatch.setenv("DATABASE_URL", "postgresql://never:connect@invalid/live")
    sqlite = Database(":memory:")
    assert sqlite.dialect == "sqlite"
    sqlite.sqlite.close()
