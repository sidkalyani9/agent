import asyncio
import os
import pytest
from pantry import core as c, inventory as i, accounts as a, receipts
from .test_accounts import fails


async def test_office_creation_and_audit_are_atomic(db, people, monkeypatch):
    before = (await db.get("SELECT count(*) AS n FROM office"))["n"]
    original = i.log
    calls = 0
    async def broken(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise RuntimeError("induced audit failure")
        return await original(*args, **kwargs)
    monkeypatch.setattr(i, "log", broken)
    with pytest.raises(RuntimeError):
        await i.create_office(db, people["admin"], "Atomic office", people["manager"]["id"])
    assert (await db.get("SELECT count(*) AS n FROM office"))["n"] == before
    assert not await db.get("SELECT id FROM office WHERE name = 'Atomic office'")
    monkeypatch.setattr(i, "log", original)
    office = await i.create_office(db, people["admin"], "Atomic office", people["manager"]["id"])
    pantry = await i.get_pantry(db, people["manager"], office["id"])
    assert len(pantry["products"]) == 5 and all(p["onHand"] == "0.00" for p in pantry["products"])
    assert len(await db.all("SELECT c.id FROM pantry_count c JOIN pantry_product p ON p.id = c.product_id WHERE p.office_id = ?", office["id"])) == 5


async def test_receipts_validation_retry_immutability_and_authorization(db, people, offices, monkeypatch):
    office = offices["Ahmedabad"]
    product = (await i.create_product(db, people["manager"], office, "Receipt product"))["productId"]
    body = {"productId": product, "date": "2026-09-20", "packs": 2, "pricePerPack": "12.50"}
    receipt = {"fileName": "../receipt.pdf", "bytes": b"%PDF-1.4\nreceipt\n%%EOF"}
    original = receipts.store_receipt
    async def outage(*args):
        raise OSError("induced storage failure")
    monkeypatch.setattr(receipts, "store_receipt", outage)
    saved = await i.create_purchase(db, people["manager"], office, body, receipt, "receipt-retry-001")
    assert saved["purchaseId"] and not saved["receiptSaved"]
    assert await db.get("SELECT id FROM pantry_purchase WHERE id = ?", saved["purchaseId"])
    monkeypatch.setattr(receipts, "store_receipt", original)
    retried = await i.create_purchase(db, people["manager"], office, body, receipt, "receipt-retry-001")
    assert retried["purchaseId"] == saved["purchaseId"] and retried["receiptSaved"]
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase WHERE product_id = ?", product))["n"] == 1
    metadata = await db.get("SELECT * FROM pantry_receipt WHERE purchase_id = ?", saved["purchaseId"])
    file = await i.receipt_file(db, people["reader"], saved["purchaseId"])
    assert file["bytes"] == receipt["bytes"] and file["fileName"] == "receipt.pdf"
    with fails(404):
        await i.receipt_file(db, people["other"], saved["purchaseId"])
    with fails(403):
        await i.attach_receipt(db, people["reader"], saved["purchaseId"], receipt)
    await i.attach_receipt(db, people["admin"], saved["purchaseId"], {"fileName": "image.png", "bytes": b"\x89PNG\r\n\x1a\nnew"})
    replaced = await db.get("SELECT * FROM pantry_receipt WHERE purchase_id = ?", saved["purchaseId"])
    assert replaced["blob_path"] != metadata["blob_path"]
    assert replaced["created_by"] == metadata["created_by"] and replaced["created_at"] == metadata["created_at"]
    assert await receipts.read_receipt(metadata["blob_path"]) == receipt["bytes"]
    for data, message in [(b"", "empty"), (b"<html>wrong</html>", "PDF, JPEG, or PNG"), (b"%PDF-" + b"x" * (10 * 1024 * 1024), "at most 10 MB")]:
        result = await i.create_purchase(db, people["manager"], office, body, {"fileName": "bad.pdf", "bytes": data})
        assert not result["receiptSaved"] and message in result["receiptError"]
        assert await db.get("SELECT id FROM pantry_purchase WHERE id = ?", result["purchaseId"])
    await i.delete_purchase(db, people["manager"], saved["purchaseId"])
    assert (await db.get("SELECT deleted_at FROM pantry_receipt WHERE purchase_id = ?", saved["purchaseId"]))["deleted_at"]
    with fails(404):
        await i.receipt_file(db, people["reader"], saved["purchaseId"])


async def test_receipt_audit_failure_keeps_purchase_but_rolls_back_metadata(db, people, offices, monkeypatch):
    product = (await i.get_pantry(db, people["manager"], offices["Ahmedabad"]))["products"][0]["productId"]
    original = i.log
    async def audit_failure(db, actor_id, action, *args):
        if action.startswith("receipt."):
            raise RuntimeError("induced receipt audit failure")
        return await original(db, actor_id, action, *args)
    monkeypatch.setattr(i, "log", audit_failure)
    saved = await i.create_purchase(db, people["manager"], offices["Ahmedabad"], {"productId": product, "date": "2026-09-20", "packs": 1, "pricePerPack": "10"}, {"fileName": "r.pdf", "bytes": b"%PDF-1.4\nhello"})
    assert not saved["receiptSaved"]
    assert await db.get("SELECT id FROM pantry_purchase WHERE id = ?", saved["purchaseId"])
    assert not await db.get("SELECT purchase_id FROM pantry_receipt WHERE purchase_id = ?", saved["purchaseId"])
    monkeypatch.setattr(i, "log", original)
    assert (await i.attach_receipt(db, people["manager"], saved["purchaseId"], {"fileName": "r.pdf", "bytes": b"%PDF-1.4\nhello"}))["receiptSaved"]


async def test_counts_corrections_hidden_spend_and_csv_attribution(db, people, offices):
    manager, office = people["manager"], offices["Ahmedabad"]
    product = (await i.create_product(db, manager, office, '=HYPERLINK("https://example.invalid","Open")'))["productId"]
    saved = await i.create_purchase(db, manager, office, {"productId": product, "date": "2026-09-19", "packs": 2, "pricePerPack": "10"})
    before = await db.get("SELECT * FROM pantry_purchase WHERE id = ?", saved["purchaseId"])
    await i.correct_purchase(db, people["admin"], saved["purchaseId"], {"packs": 3})
    after = await db.get("SELECT * FROM pantry_purchase WHERE id = ?", saved["purchaseId"])
    assert before["created_by"] == after["created_by"] and before["created_at"] == after["created_at"]
    count = await i.upsert_count(db, manager, office, {"productId": product, "date": "2026-09-19", "packs": 2})
    before = await db.get("SELECT * FROM pantry_count WHERE id = ?", count["countId"])
    await i.upsert_count(db, people["admin"], office, {"productId": product, "date": "2026-09-19", "packs": 1})
    after = await db.get("SELECT * FROM pantry_count WHERE id = ?", count["countId"])
    assert before["created_by"] == after["created_by"] and before["created_at"] == after["created_at"]
    await i.hide_product(db, manager, product)
    pantry = await i.get_pantry(db, manager, office, "2026-09")
    assert next(p for p in pantry["products"] if p["productId"] == product)["spend"] == "30.00"
    exported = await i.export_csv(db, manager, office, "2026-09")
    assert '"\'=HYPERLINK' in exported["body"] and "Meera Patel" in exported["body"]
    await i.delete_purchase(db, manager, saved["purchaseId"])
    assert not any(p["productId"] == product for p in (await i.get_pantry(db, manager, office))["products"])


@pytest.mark.parametrize("name", ["..", ".", "../file.pdf", "/file.pdf", "a/b.pdf", "a\\b", "", "x" * 161])
def test_storage_names_cannot_escape_receipt_directory(name):
    with pytest.raises(ValueError):
        receipts.safe_blob_name(name)


async def test_nested_transactions_rollback_without_losing_outer_work(db):
    async with db.transaction():
        await db.run("UPDATE company_setting SET lookback_months = 4 WHERE id = 1")
        with pytest.raises(RuntimeError):
            async with db.transaction():
                await db.run("UPDATE company_setting SET weekend_weight = .8 WHERE id = 1")
                raise RuntimeError("rollback inner")
        current = await c.settings(db)
        assert current == {"lookbackMonths": 4, "weekendWeight": .2}
    assert (await c.settings(db))["lookbackMonths"] == 4
