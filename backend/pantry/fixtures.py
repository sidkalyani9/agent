"""Test-only fixture data. Never enabled in production."""
import json
from pathlib import Path
from . import core as c
from . import inventory as inv


async def seed_fixtures(db):
    saved = c.set_clock(lambda: c.parse_stamp("2026-07-01T04:30:00.000Z"))
    try:
        people = {}
        for mailbox, name in [("avery.shah", "Avery Shah"), ("meera.patel", "Meera Patel"), ("rohan.desai", "Rohan Desai"), ("isha.rao", "Isha Rao"), ("kabir.mehta", "Kabir Mehta")]:
            person_id = c.new_id()
            email = mailbox + "@intuitive.AI"
            await db.run("INSERT INTO person (id, directory_object_id, sign_in_name, display_name, active) VALUES (?, ?, ?, ?, 1)", person_id, "local:" + email.lower(), email, name)
            people[mailbox.split(".")[0]] = person_id
        avery = people["avery"]
        await c.grant(db, avery, avery, "super_admin", None)
        actor = await c.present_person(db, await c.person_by_id(db, avery))
        ahmedabad = await inv.create_office(db, actor, "Ahmedabad")
        pune = await inv.create_office(db, actor, "Pune")
        for name, person_id in people.items():
            await db.run("UPDATE person SET home_office_id = ? WHERE id = ?", pune["id"] if name == "rohan" else ahmedabad["id"], person_id)
        for name, role, office in [("meera", "office_manager", ahmedabad), ("rohan", "office_manager", pune), ("isha", "admin", ahmedabad), ("kabir", "accounts", ahmedabad), ("kabir", "accounts", pune)]:
            await c.grant(db, avery, people[name], role, office["id"])
    finally:
        c._clock.reset(saved)


async def apply_demo_history(db):
    meera = await db.get("SELECT * FROM person WHERE sign_in_name = 'meera.patel@intuitive.AI' COLLATE NOCASE")
    rohan = await db.get("SELECT * FROM person WHERE sign_in_name = 'rohan.desai@intuitive.AI' COLLATE NOCASE")
    if not meera or not rohan:
        return
    actors = {"Ahmedabad": await c.present_person(db, meera), "Pune": await c.present_person(db, rohan)}
    fixtures = json.loads(Path(__file__).with_name("fixtures.json").read_text())
    saved = c.set_clock(None)
    try:
        for office_name, product_name, day, packs, price in fixtures["DEMO_PURCHASES"]:
            office = await db.get("SELECT id FROM office WHERE name = ?", office_name)
            if not office:
                continue
            product = await db.get("SELECT id FROM pantry_product WHERE office_id = ? AND name = ? AND deleted_at IS NULL", office["id"], product_name)
            if not product:
                continue
            if await db.get("SELECT id FROM pantry_purchase WHERE product_id = ? AND purchased_on = ? AND packs = ? AND price_per_pack = ? AND deleted_at IS NULL", product["id"], day, packs, price):
                continue
            c.set_clock(lambda day=day: c.parse_stamp(day + "T05:00:00.000Z"))
            await inv.create_purchase(db, actors[office_name], office["id"], {"productId": product["id"], "date": day, "packs": packs, "pricePerPack": price})
        for office_name, product_name, day, packs in fixtures["DEMO_COUNTS"]:
            office = await db.get("SELECT id FROM office WHERE name = ?", office_name)
            if not office:
                continue
            product = await db.get("SELECT id FROM pantry_product WHERE office_id = ? AND name = ? AND deleted_at IS NULL", office["id"], product_name)
            if not product:
                continue
            if await db.get("SELECT id FROM pantry_count WHERE product_id = ? AND counted_on = ? AND deleted_at IS NULL", product["id"], day):
                continue
            c.set_clock(lambda day=day: c.parse_stamp(day + "T04:30:00.000Z"))
            await inv.upsert_count(db, actors[office_name], office["id"], {"productId": product["id"], "date": day, "packs": packs})
    finally:
        c._clock.reset(saved)
