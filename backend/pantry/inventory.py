"""Office, stock, spend, receipt and activity operations."""
import hashlib
import json
import math
import re
from datetime import date
from .core import (HttpError, scoped, transactional, live_person, sees_every_office, require_view, require_write,
                   can_write, office_by_id, person_by_id, present_person, grant, log, now, stamp, new_id, settings,
                   names_by_id, STARTERS)
from .compat import text, number, fixed, dumps
from . import calc
from . import receipts


@scoped
async def list_offices(db, person):
    person = await live_person(db, person)
    rows = await db.all("SELECT * FROM office ORDER BY name") if sees_every_office(person) else await db.all("SELECT DISTINCT o.* FROM office o JOIN role_grant g ON g.office_id = o.id WHERE g.person_id = ? AND g.deleted_at IS NULL ORDER BY o.name", person["id"])
    return [{"id": r["id"], "name": r["name"]} for r in rows]


async def insert_product(db, actor, office_id, name, at=None):
    at = at or stamp()
    product_id = new_id()
    await db.run("INSERT INTO pantry_product (id, office_id, name, reorder_level, warning_effective_days, created_by, created_at) VALUES (?, ?, ?, 0, 5, ?, ?)", product_id, office_id, name, actor["id"], at)
    await db.run("INSERT INTO pantry_count (id, product_id, counted_on, packs, created_by, created_at) VALUES (?, ?, ?, 0, ?, ?)", new_id(), product_id, calc.today_in_india(now()), actor["id"], at)
    return product_id


async def active_person(db, person_id):
    person = await person_by_id(db, person_id)
    return person if person and person["active"] else None


async def name_manager(db, actor, office, manager):
    if await db.get("SELECT id FROM role_grant WHERE person_id = ? AND role = 'office_manager' AND office_id = ? AND deleted_at IS NULL", manager["id"], office["id"]):
        raise HttpError(422, f"{manager['display_name']} is already the Office Manager at {office['name']}.")
    await grant(db, actor["id"], manager["id"], "office_manager", office["id"])
    await log(db, actor["id"], "grant.grant", "person", manager["id"], office["id"], f"Named {manager['display_name']} Office Manager at {office['name']}.")


@transactional
async def create_office(db, person, name, manager_id=None):
    person = await live_person(db, person)
    if not person["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can add an office.")
    clean = text(name or "").strip()
    if not clean or len(clean) > 80:
        raise HttpError(422, "An office name is required, up to 80 characters.")
    if await db.get("SELECT id FROM office WHERE name = ? COLLATE NOCASE", clean):
        raise HttpError(422, "An office with that name already exists.")
    manager = await active_person(db, manager_id) if manager_id else None
    if manager_id and not manager:
        raise HttpError(422, "Choose an Office Manager from the people on this pantry.")
    at, office_id = stamp(), new_id()
    await db.run("INSERT INTO office (id, name, created_by, created_at) VALUES (?, ?, ?, ?)", office_id, clean, person["id"], at)
    await log(db, person["id"], "office.create", "office", office_id, office_id, f"Added the {clean} office.")
    for starter in STARTERS:
        product_id = await insert_product(db, person, office_id, starter, at)
        await log(db, person["id"], "product.create", "product", product_id, office_id, f"Opened {starter} at {clean}.")
    if manager:
        await name_manager(db, person, {"id": office_id, "name": clean}, manager)
    return {"id": office_id, "name": clean, "managerId": manager["id"] if manager else None, "managerName": manager["display_name"] if manager else None}


@transactional
async def assign_office_manager(db, person, office_id, person_id):
    person = await live_person(db, person)
    if not person["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can assign an Office Manager.")
    office = await office_by_id(db, office_id)
    if not office:
        raise HttpError(404, "Office not found.")
    manager = await active_person(db, person_id)
    if not manager:
        raise HttpError(422, "Choose an Office Manager from the people on this pantry.")
    await name_manager(db, person, office, manager)
    return {"officeId": office_id, "personId": manager["id"], "displayName": manager["display_name"]}


@scoped
async def list_people(db, person):
    person = await live_person(db, person)
    if not person["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can assign an Office Manager.")
    return [{"id": r["id"], "displayName": r["display_name"], "email": r["sign_in_name"], "managerOf": [o["id"] for o in await db.all("SELECT o.id FROM role_grant g JOIN office o ON o.id = g.office_id WHERE g.person_id = ? AND g.role = 'office_manager' AND g.deleted_at IS NULL", r["id"])]} for r in await db.all("SELECT id, display_name, sign_in_name FROM person WHERE active = 1 ORDER BY display_name")]


@transactional
async def rename_office(db, person, office_id, name):
    person = await live_person(db, person)
    if not person["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can rename an office.")
    if not await office_by_id(db, office_id):
        raise HttpError(404, "Office not found.")
    clean = text(name or "").strip()
    if not clean or len(clean) > 80:
        raise HttpError(422, "An office name is required, up to 80 characters.")
    await db.run("UPDATE office SET name = ? WHERE id = ?", clean, office_id)
    await log(db, person["id"], "office.rename", "office", office_id, office_id, f"Renamed an office to {clean}.")
    return {"id": office_id, "name": clean}


def present_purchase(row):
    return {out: row[key] for out, key in {"id": "id", "productId": "product_id", "purchasedOn": "purchased_on", "packs": "packs", "pricePerPack": "price_per_pack", "createdAt": "created_at", "createdBy": "created_by", "deletedAt": "deleted_at"}.items()}


def present_count(row):
    return {out: row[key] for out, key in {"id": "id", "productId": "product_id", "countedOn": "counted_on", "packs": "packs", "createdAt": "created_at", "deletedAt": "deleted_at"}.items()}


def validate_month(month):
    if not re.fullmatch(r"[1-9]\d{3}-(0[1-9]|1[0-2])", text(month or "")):
        raise HttpError(422, "Choose a valid calendar month.")
    return month


@scoped
async def get_pantry(db, person, office_id, month=None, *, series=True):
    person = await live_person(db, person)
    require_view(person, office_id)
    office = await office_by_id(db, office_id)
    if not office:
        raise HttpError(404, "Office not found.")
    today = calc.today_in_india(now())
    selected = validate_month(month or today[:7])
    config, names = await settings(db), await names_by_id(db)
    frame = calc.next_month_frame(config, today)
    products = []
    for product in await db.all("SELECT * FROM pantry_product WHERE office_id = ? ORDER BY created_at, name", office_id):
        purchases = [present_purchase(r) for r in await db.all("SELECT * FROM pantry_purchase WHERE product_id = ?", product["id"])]
        counts = [present_count(r) for r in await db.all("SELECT * FROM pantry_count WHERE product_id = ?", product["id"])]
        math_result = calc.compute_product(product={"reorderLevel": product["reorder_level"], "warningEffectiveDays": product["warning_effective_days"]}, purchases=purchases, counts=counts, settings=config, today=today)
        month_stats, basis = calc.month_figures(purchases, selected), calc.month_figures(purchases, today[:7])
        forecast = calc.project_month(purchases=purchases, math=math_result, settings=config, today=today, basisPacks=basis["packsAdded"], basisSpend=basis["spend"])
        receipt = await db.get("SELECT purchase_id FROM pantry_receipt r JOIN pantry_purchase p ON p.id = r.purchase_id WHERE p.product_id = ? AND r.deleted_at IS NULL LIMIT 1", product["id"])
        row = {"productId": product["id"], "name": product["name"], "deletedAt": product["deleted_at"], "createdBy": names.get(product["created_by"], "Unknown"), "createdAt": product["created_at"], "createdAtLabel": calc.format_when(product["created_at"]), **math_result, **month_stats, "history": calc.month_history(purchases, config, today), "forecast": forecast, "hasReceipt": bool(receipt)}
        if series:
            row["series"] = calc.stock_series(purchases=purchases, counts=counts, settings=config, today=today, burnRate=math_result["burnRatePerEffectiveDay"], expectedDate=math_result["expectedDate"], onHand=math_result["onHand"])
        products.append(row)
    visible = [p for p in products if not p["deletedAt"] or p["packsAdded"] > 0]
    forecast_rows = [p for p in products if not p["deletedAt"] and p["forecast"]["spend"]]
    return {"officeId": office_id, "officeName": office["name"], "month": selected, "today": today, "currency": "INR", "spend": calc.add_money([p["spend"] for p in visible]), "forecast": {**frame, "spend": calc.add_money([p["forecast"]["spend"] for p in forecast_rows]) if forecast_rows else None}, "canWrite": can_write(person, office_id), "settings": config, "products": visible}


@scoped
async def summary(db, person, month=None):
    person = await live_person(db, person)
    if not sees_every_office(person):
        raise HttpError(403, "All offices is for a Super Admin or an Admin.")
    selected = month or calc.today_in_india(now())[:7]
    offices = []
    for office in await list_offices(db, person):
        pantry = await get_pantry(db, person, office["id"], selected, series=False)
        offices.append({"officeId": office["id"], "name": office["name"], "spend": pantry["spend"], "forecastSpend": pantry["forecast"]["spend"]})
    forecasts = [o["forecastSpend"] for o in offices if o["forecastSpend"]]
    frame = calc.next_month_frame(await settings(db), calc.today_in_india(now()))
    return {"month": selected, "forecastMonth": frame["month"], "effectiveDays": frame["effectiveDays"], "offices": offices, "spend": calc.add_money([o["spend"] for o in offices]), "forecastSpend": calc.add_money(forecasts) if forecasts else None}


def validate_product_name(name):
    if not name or len(name) > 120 or re.search(r"[\x00-\x1f]", name):
        raise HttpError(422, "A product name needs 1 to 120 characters without control characters.")


@transactional
async def create_product(db, person, office_id, name):
    person = await live_person(db, person)
    require_write(person, office_id)
    office = await office_by_id(db, office_id)
    if not office:
        raise HttpError(404, "Office not found.")
    clean = text(name or "").strip()
    validate_product_name(clean)
    if await db.get("SELECT id FROM pantry_product WHERE office_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL", office_id, clean):
        raise HttpError(422, f"{clean} is already on this office's pantry.")
    product_id = await insert_product(db, person, office_id, clean)
    await log(db, person["id"], "product.create", "product", product_id, office_id, f"Added {clean} at {office['name']}.")
    return {"productId": product_id, "name": clean}


@transactional
async def update_product(db, person, product_id, body):
    person = await live_person(db, person)
    product = await db.get("SELECT * FROM pantry_product WHERE id = ?", product_id)
    if not product:
        raise HttpError(404, "Product not found.")
    require_write(person, product["office_id"])
    name = text(body["name"]).strip() if body.get("name") is not None else product["name"]
    reorder = number(body["reorderLevel"]) if body.get("reorderLevel") is not None else product["reorder_level"]
    warning = number(body["warningEffectiveDays"]) if body.get("warningEffectiveDays") is not None else product["warning_effective_days"]
    validate_product_name(name)
    if not math.isfinite(reorder) or reorder != int(reorder) or not 0 <= reorder <= 1_000_000:
        raise HttpError(422, "Reorder level is a whole number from 0 to 1000000.")
    if not math.isfinite(warning) or warning != int(warning) or not 1 <= warning <= 366:
        raise HttpError(422, "The warning window is from 1 to 366 effective days.")
    if await db.get("SELECT id FROM pantry_product WHERE office_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL AND id != ?", product["office_id"], name, product_id):
        raise HttpError(422, "That product name is already in use at this office.")
    await db.run("UPDATE pantry_product SET name = ?, reorder_level = ?, warning_effective_days = ? WHERE id = ?", name, int(reorder), int(warning), product_id)
    await log(db, person["id"], "product.rename" if name != product["name"] else "product.reorder", "product", product_id, product["office_id"], f"Updated {name}.")
    return {"productId": product_id, "name": name}


@transactional
async def hide_product(db, person, product_id):
    person = await live_person(db, person)
    product = await db.get("SELECT * FROM pantry_product WHERE id = ?", product_id)
    if not product or product["deleted_at"]:
        raise HttpError(404, "Product not found.")
    require_write(person, product["office_id"])
    await db.run("UPDATE pantry_product SET deleted_by = ?, deleted_at = ? WHERE id = ?", person["id"], stamp(), product_id)
    await log(db, person["id"], "product.hide", "product", product_id, product["office_id"], f"Hid {product['name']}.")
    return {"productId": product_id, "hidden": True}


@transactional
async def delete_product(db, person, product_id):
    person = await live_person(db, person)
    product = await db.get("SELECT * FROM pantry_product WHERE id = ?", product_id)
    if not product or product["deleted_at"]:
        raise HttpError(404, "Product not found.")
    require_write(person, product["office_id"])
    at = stamp()
    await db.run("UPDATE pantry_receipt SET deleted_by = ?, deleted_at = ? WHERE deleted_at IS NULL AND purchase_id IN (SELECT id FROM pantry_purchase WHERE product_id = ?)", person["id"], at, product_id)
    for table in ("pantry_purchase", "pantry_count"):
        await db.run(f"UPDATE {table} SET deleted_by = ?, deleted_at = ? WHERE product_id = ? AND deleted_at IS NULL", person["id"], at, product_id)
    await db.run("UPDATE pantry_product SET deleted_by = ?, deleted_at = ? WHERE id = ?", person["id"], at, product_id)
    await log(db, person["id"], "product.delete", "product", product_id, product["office_id"], f"Deleted {product['name']}.")
    return {"productId": product_id, "deleted": True}


@transactional
async def restore_product(db, person, product_id):
    person = await live_person(db, person)
    product = await db.get("SELECT * FROM pantry_product WHERE id = ?", product_id)
    if not product or not product["deleted_at"]:
        raise HttpError(404, "Product not found.")
    require_write(person, product["office_id"])
    if await db.get("SELECT id FROM pantry_product WHERE office_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL", product["office_id"], product["name"]):
        raise HttpError(422, f"{product['name']} is already active at this office.")
    await db.run("UPDATE pantry_product SET deleted_by = NULL, deleted_at = NULL WHERE id = ?", product_id)
    await log(db, person["id"], "product.restore", "product", product_id, product["office_id"], f"Restored {product['name']}.")
    return {"productId": product_id, "hidden": False}


def parse_packs(value, *, allow_zero=False):
    packs = number(value)
    if value == "" or value is None or isinstance(value, bool) or not math.isfinite(packs) or packs != int(packs) or packs > 1_000_000 or packs < (0 if allow_zero else 1):
        raise HttpError(422, "Packs are a whole number, zero or more." if allow_zero else "Packs are a whole number, at least 1.")
    return int(packs)


def parse_price(value):
    price = number(value)
    if value == "" or value is None or isinstance(value, bool) or not math.isfinite(price) or not 0 <= price <= 1_000_000:
        raise HttpError(422, "Price per pack is from 0 to 1000000 INR.")
    return fixed(price)


def parse_date(value):
    value = text(value or "")
    try:
        if not re.fullmatch(r"[1-9]\d{3}-\d{2}-\d{2}", value) or date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except ValueError:
        raise HttpError(422, "Choose a valid calendar date.") from None
    if value > calc.today_in_india(now()):
        raise HttpError(422, "That date is still in the future for India.")
    return value


async def active_product(db, office_id, product_id):
    product = await db.get("SELECT * FROM pantry_product WHERE id = ? AND office_id = ?", product_id, office_id)
    if not product or product["deleted_at"]:
        raise HttpError(422, "That product is not available for a new entry.")
    return product


def purchase_hash(body, receipt):
    receipt_hash = hashlib.sha256(receipt["bytes"]).hexdigest() if receipt and "bytes" in receipt else ""
    payload = {k: body[k] for k in ("productId", "date", "packs", "pricePerPack") if k in body}
    return hashlib.sha256(dumps({**payload, "receipt": receipt_hash}).encode()).hexdigest()


@scoped
async def create_purchase(db, person, office_id, body, receipt=None, idempotency=None):
    person = await live_person(db, person)
    require_write(person, office_id)
    product = await active_product(db, office_id, body.get("productId"))
    purchased_on, packs, price = parse_date(body.get("date")), parse_packs(body.get("packs")), parse_price(body.get("pricePerPack"))
    key = text(idempotency or "").strip()
    if key and not re.fullmatch(r"[A-Za-z0-9._:-]{8,200}", key):
        raise HttpError(422, "The save key is not valid. Retry the purchase.")
    hashed = purchase_hash(body, receipt) if key else ""
    at, purchase_id, result = stamp(), new_id(), None
    async with db.transaction():
        prior = await db.get("SELECT request_hash, body FROM idempotency WHERE person_id = ? AND key = ?", person["id"], key) if key else None
        if prior:
            if prior["request_hash"] != hashed:
                raise HttpError(409, "This save was already sent with different details.")
            result = json.loads(prior["body"])
        else:
            await db.run("INSERT INTO pantry_purchase (id, product_id, purchased_on, packs, price_per_pack, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", purchase_id, product["id"], purchased_on, packs, price, person["id"], at)
            await log(db, person["id"], "purchase.create", "purchase", purchase_id, office_id, f"Entered {packs} packs of {product['name']} on {purchased_on} at ₹{price}.")
            result = {"purchaseId": purchase_id, "product": product["name"], "date": purchased_on, "packs": packs, "pricePerPack": price, "receiptSaved": False}
            if key:
                await db.run("INSERT INTO idempotency (person_id, key, request_hash, body, created_at) VALUES (?, ?, ?, ?, ?)", person["id"], key, hashed, dumps(result), at)
    if receipt is not None and not result["receiptSaved"]:
        try:
            await save_receipt(db, person, result["purchaseId"], receipt, at)
            result["receiptSaved"] = True
            result.pop("receiptError", None)
            if key:
                await db.run("UPDATE idempotency SET body = ? WHERE person_id = ? AND key = ?", dumps(result), person["id"], key)
        except Exception as error:
            result["receiptError"] = error.message if isinstance(error, HttpError) else "The receipt could not be stored. The purchase is saved."
    return result


@transactional
async def save_receipt(db, person, purchase_id, receipt, at):
    data = receipt.get("bytes") if receipt else None
    if not data:
        raise HttpError(422, "The receipt file is empty.")
    if len(data) > 10 * 1024 * 1024:
        raise HttpError(422, "A receipt is at most 10 MB.")
    content_type = receipts.sniff_receipt(data)
    if not content_type:
        raise HttpError(422, "A receipt is a PDF, JPEG, or PNG.")
    ext = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg"}[content_type]
    filename = f"{purchase_id}-{new_id()}.{ext}"
    existing = await db.get("SELECT purchase_id FROM pantry_receipt WHERE purchase_id = ?", purchase_id)
    await receipts.store_receipt(filename, data, content_type)
    file_name = receipts.safe_receipt_name(receipt.get("fileName"), filename)
    if existing:
        await db.run("UPDATE pantry_receipt SET blob_path = ?, file_name = ?, content_type = ?, byte_size = ?, deleted_by = NULL, deleted_at = NULL WHERE purchase_id = ?", filename, file_name, content_type, len(data), purchase_id)
    else:
        await db.run("INSERT INTO pantry_receipt (purchase_id, blob_path, file_name, content_type, byte_size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", purchase_id, filename, file_name, content_type, len(data), person["id"], at)
    product = await db.get("SELECT p.office_id, p.name FROM pantry_purchase u JOIN pantry_product p ON p.id = u.product_id WHERE u.id = ?", purchase_id)
    name = product["name"] if product else "a purchase"
    await log(db, person["id"], "receipt.replace" if existing else "receipt.attach", "receipt", purchase_id, product["office_id"] if product else None, f"Replaced the receipt on {name}." if existing else f"Attached a receipt to {name}.")


@transactional
async def attach_receipt(db, person, purchase_id, receipt):
    person = await live_person(db, person)
    purchase = await db.get("SELECT * FROM pantry_purchase WHERE id = ? AND deleted_at IS NULL", purchase_id)
    if not purchase:
        raise HttpError(404, "Purchase not found.")
    product = await db.get("SELECT * FROM pantry_product WHERE id = ?", purchase["product_id"])
    require_write(person, product["office_id"])
    await save_receipt(db, person, purchase_id, receipt, stamp())
    return {"purchaseId": purchase_id, "receiptSaved": True}


@scoped
async def receipt_file(db, person, purchase_id):
    person = await live_person(db, person)
    purchase = await db.get("SELECT * FROM pantry_purchase WHERE id = ?", purchase_id)
    if not purchase:
        raise HttpError(404, "Purchase not found.")
    product = await db.get("SELECT * FROM pantry_product WHERE id = ?", purchase["product_id"])
    require_view(person, product["office_id"])
    receipt = await db.get("SELECT * FROM pantry_receipt WHERE purchase_id = ? AND deleted_at IS NULL", purchase_id)
    if not receipt:
        raise HttpError(404, "This purchase has no receipt.")
    try:
        data = await receipts.read_receipt(receipt["blob_path"])
    except Exception as error:
        if isinstance(error, FileNotFoundError) or getattr(error, "status_code", None) == 404:
            raise HttpError(404, "The receipt file is missing.") from None
        raise
    return {"bytes": data, "contentType": receipt["content_type"], "fileName": receipts.safe_receipt_name(receipt["file_name"], "receipt")}


@transactional
async def correct_purchase(db, person, purchase_id, body):
    person = await live_person(db, person)
    purchase = await db.get("SELECT * FROM pantry_purchase WHERE id = ? AND deleted_at IS NULL", purchase_id)
    if not purchase:
        raise HttpError(404, "Purchase not found.")
    product = await db.get("SELECT * FROM pantry_product WHERE id = ?", purchase["product_id"])
    require_write(person, product["office_id"])
    purchased_on = parse_date(body["date"]) if body.get("date") else purchase["purchased_on"]
    packs = parse_packs(body["packs"]) if body.get("packs") is not None else purchase["packs"]
    price = parse_price(body["pricePerPack"]) if body.get("pricePerPack") is not None else purchase["price_per_pack"]
    await db.run("UPDATE pantry_purchase SET purchased_on = ?, packs = ?, price_per_pack = ? WHERE id = ?", purchased_on, packs, price, purchase_id)
    await log(db, person["id"], "purchase.correct", "purchase", purchase_id, product["office_id"], f"Corrected {product['name']} to {packs} packs on {purchased_on}. The original entry stays with its first person.")
    return {"purchaseId": purchase_id}


@transactional
async def upsert_count(db, person, office_id, body):
    person = await live_person(db, person)
    require_write(person, office_id)
    product = await active_product(db, office_id, body.get("productId"))
    counted_on, packs = parse_date(body.get("date")), parse_packs(body.get("packs"), allow_zero=True)
    existing = await db.get("SELECT * FROM pantry_count WHERE product_id = ? AND counted_on = ?", product["id"], counted_on)
    if not existing:
        count_id = new_id()
        await db.run("INSERT INTO pantry_count (id, product_id, counted_on, packs, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", count_id, product["id"], counted_on, packs, person["id"], stamp())
        await log(db, person["id"], "count.enter", "count", count_id, office_id, f"Counted {packs} packs of {product['name']} on {counted_on}.")
    else:
        count_id = existing["id"]
        await db.run("UPDATE pantry_count SET packs = ?, deleted_by = NULL, deleted_at = NULL WHERE id = ?", packs, count_id)
        await log(db, person["id"], "count.correct", "count", count_id, office_id, f"Updated the {counted_on} count of {product['name']} to {packs}. The first person on that count stays.")
    return {"countId": count_id}


@transactional
async def _remove_row(db, person, row_id, kind, delete):
    person = await live_person(db, person)
    table = "pantry_purchase" if kind == "purchase" else "pantry_count"
    row = await db.get(f"SELECT * FROM {table} WHERE id = ? AND deleted_at IS NULL", row_id)
    if not row:
        raise HttpError(404, "Purchase not found." if kind == "purchase" else "Count not found.")
    product = await db.get("SELECT * FROM pantry_product WHERE id = ?", row["product_id"])
    require_write(person, product["office_id"])
    at = stamp()
    if delete and kind == "purchase":
        await db.run("UPDATE pantry_receipt SET deleted_by = ?, deleted_at = ? WHERE purchase_id = ? AND deleted_at IS NULL", person["id"], at, row_id)
    await db.run(f"UPDATE {table} SET deleted_by = ?, deleted_at = ? WHERE id = ?", person["id"], at, row_id)
    if delete:
        message = f"Deleted a purchase of {row['packs']} packs of {product['name']} on {row['purchased_on']}." if kind == "purchase" else f"Deleted the {row['counted_on']} shelf count of {row['packs']} packs of {product['name']}."
    else:
        message = f"Withdrew a {product['name']} purchase. The row stays." if kind == "purchase" else f"Withdrew a count of {product['name']}. The row stays."
    await log(db, person["id"], f"{kind}.{'delete' if delete else 'hide'}", kind, row_id, product["office_id"], message)
    return {f"{kind}Id": row_id, "deleted" if delete else "hidden": True}


async def hide_purchase(db, person, purchase_id):
    return await _remove_row(db, person, purchase_id, "purchase", False)


async def delete_purchase(db, person, purchase_id):
    return await _remove_row(db, person, purchase_id, "purchase", True)


async def hide_count(db, person, count_id):
    return await _remove_row(db, person, count_id, "count", False)


async def delete_count(db, person, count_id):
    return await _remove_row(db, person, count_id, "count", True)


@scoped
async def list_operations(db, person, office_id, range=None):
    person = await live_person(db, person)
    require_view(person, office_id)
    names, rows = await names_by_id(db), []
    period = range or {}
    for row in await db.all("SELECT * FROM operation WHERE office_id = ? ORDER BY at DESC", office_id):
        day = calc.today_in_india(calc.datetime.fromisoformat(row["at"].replace("Z", "+00:00")))
        if (period.get("from") and day < period["from"]) or (period.get("to") and day > period["to"]):
            continue
        rows.append({k: row[k] for k in ("id", "action", "summary", "at")} | {"atLabel": calc.format_when(row["at"]), "actor": names.get(row["actor_id"], "Unknown")})
    return rows[:300 if period.get("from") or period.get("to") else 40]


@scoped
async def export_csv(db, person, office_id, month=None):
    person = await live_person(db, person)
    pantry = await get_pantry(db, person, office_id, month)
    lines = [["Product", "Date", "Packs", "Price per pack (INR)", "Amount (INR)", "Receipt", "Entered by", "Entered at (IST)"]]
    names = await names_by_id(db)
    for product in pantry["products"]:
        for row in await db.all("SELECT * FROM pantry_purchase WHERE product_id = ? AND deleted_at IS NULL AND purchased_on LIKE ? ORDER BY purchased_on, created_at", product["productId"], pantry["month"] + "%"):
            receipt = await db.get("SELECT purchase_id FROM pantry_receipt WHERE purchase_id = ? AND deleted_at IS NULL", row["id"])
            lines.append([product["name"], row["purchased_on"], text(row["packs"]), row["price_per_pack"], calc.money(row["packs"], row["price_per_pack"]), "Yes" if receipt else "No", names.get(row["created_by"], "Unknown"), calc.format_when(row["created_at"])])
    lines.append(["Office total", "", "", "", pantry["spend"], "", "", ""])
    def cell(value):
        value = text(value)
        if re.search(r"^[\s\x00-\x1f]*[=+@-]|^[\t\r\n]", value):
            value = "'" + value
        return '"' + value.replace('"', '""') + '"'
    return {"filename": f"{pantry['officeName']}-{pantry['month']}.csv", "body": "\ufeff" + "\r\n".join(",".join(cell(v) for v in row) for row in lines)}


@scoped
async def list_purchases(db, person, office_id, month):
    person = await live_person(db, person)
    require_view(person, office_id)
    validate_month(month)
    rows = await db.all("""SELECT u.*, p.name, a.display_name, r.file_name FROM pantry_purchase u JOIN pantry_product p ON p.id = u.product_id
        LEFT JOIN person a ON a.id = u.created_by LEFT JOIN pantry_receipt r ON r.purchase_id = u.id AND r.deleted_at IS NULL
        WHERE p.office_id = ? AND u.deleted_at IS NULL AND u.purchased_on LIKE ? ORDER BY u.purchased_on DESC, u.created_at DESC""", office_id, month + "-%")
    return [{"purchaseId": r["id"], "product": r["name"], "date": r["purchased_on"], "packs": r["packs"], "pricePerPack": r["price_per_pack"], "amount": calc.money(r["packs"], r["price_per_pack"]), "enteredBy": r["display_name"] or "Unknown", "receiptName": r["file_name"] or None} for r in rows]


@transactional
async def update_settings(db, person, body):
    person = await live_person(db, person)
    if not person["superAdmin"]:
        raise HttpError(403, "Only a Super Admin can change the weekend weight or the lookback.")
    current = await settings(db)
    weight = number(body["weekendWeight"]) if body.get("weekendWeight") is not None else current["weekendWeight"]
    lookback = number(body["lookbackMonths"]) if body.get("lookbackMonths") is not None else current["lookbackMonths"]
    if not math.isfinite(weight) or not 0 <= weight <= 1:
        raise HttpError(422, "Weekend weight is from 0 to 1.")
    if not math.isfinite(lookback) or lookback != int(lookback) or not 2 <= lookback <= 36:
        raise HttpError(422, "Lookback is a whole number of months from 2 to 36.")
    await db.run("UPDATE company_setting SET weekend_weight = ?, lookback_months = ? WHERE id = 1", weight, int(lookback))
    await log(db, person["id"], "settings.update", "settings", "00000000-0000-4000-8000-000000000001", None, f"Set weekend weight to {text(weight)} and lookback to {text(lookback)} months.")
    return await settings(db)
