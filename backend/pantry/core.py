"""Shared persistence, live authorization, schema and attribution."""
import os
import re
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone, timedelta
from functools import wraps
from pathlib import Path
from .compat import text
from .config import UUID, production
from .database import Database
from .identity import intuitive_sign_in_name

STARTERS = ["Coffee", "Milk", "Sugar", "Tea", "Sticks"]
ROLE_LABEL = {"super_admin": "Super Admin", "office_manager": "Office Manager", "admin": "Admin", "accounts": "Accounts"}
ROLES = set(ROLE_LABEL)
_clock = ContextVar("pantry_clock", default=None)
chat_thread = ContextVar("pantry_chat_thread", default=None)


class HttpError(Exception):
    def __init__(self, status, message, code=""):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code


def now():
    clock = _clock.get()
    return clock() if clock else datetime.now(timezone.utc)


def set_clock(fn=None):
    return _clock.set(fn)


def stamp(value=None):
    return (value or now()).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def later(seconds):
    return stamp(now() + timedelta(seconds=seconds))


def new_id():
    return str(uuid.uuid4())


def clean_name(value):
    return re.sub(r"[\x00-\x1f]", "", text(value or "")).strip()[:120]


def scoped(fn):
    @wraps(fn)
    async def call(db, *args, **kwargs):
        async with db.scope():
            return await fn(db, *args, **kwargs)
    return call


def transactional(fn):
    @wraps(fn)
    async def call(db, *args, **kwargs):
        async with db.transaction():
            return await fn(db, *args, **kwargs)
    return call


async def migrate(db):
    await db.exec(Path(__file__).with_name("schema.sql").read_text())
    columns = {r["name"] for r in await db.all("PRAGMA table_info(session)")}
    if "token" in columns and "token_hash" not in columns:
        await db.exec("DROP TABLE session")
        await db.exec("""CREATE TABLE session (token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL,
            csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
            absolute_expires_at TEXT NOT NULL, graph_refresh TEXT)""")
    columns = {r["name"] for r in await db.all("PRAGMA table_info(person)")}
    for name, ddl in [("password_hash", "TEXT"), ("must_set_password", "INTEGER NOT NULL DEFAULT 0"), ("failed_attempts", "INTEGER NOT NULL DEFAULT 0"), ("locked_until", "TEXT"), ("invited_at", "TEXT")]:
        if name not in columns:
            await db.exec(f"ALTER TABLE person ADD COLUMN {name} {ddl}")
    if "thread_id" not in {r["name"] for r in await db.all("PRAGMA table_info(proposal)")}:
        await db.exec("ALTER TABLE proposal ADD COLUMN thread_id TEXT")
    if not await db.get("SELECT id FROM company_setting WHERE id = 1"):
        await db.run("INSERT INTO company_setting (id, weekend_weight, lookback_months) VALUES (1, 0.2, 3)")


async def open_database(file=None, *, seed=None, url=None):
    mode = seed or ("fixtures" if os.getenv("PANTRY_SEED") == "fixtures" else "production")
    if production() and mode == "fixtures":
        raise ValueError("Fixture data is forbidden in production.")
    db = await Database(file, url=url).open()
    try:
        async with db.scope():
            await migrate(db)
            if mode == "fixtures":
                from .fixtures import seed_fixtures, apply_demo_history
                if not await db.get("SELECT id FROM office LIMIT 1"):
                    await seed_fixtures(db)
                await apply_demo_history(db)
            elif mode != "none":
                await seed_production(db)
        return db
    except BaseException:
        await db.close()
        raise


async def person_by_id(db, person_id):
    return await db.get("SELECT * FROM person WHERE id = ?", person_id)


async def live_person(db, supplied):
    row = await person_by_id(db, supplied.get("id")) if supplied and supplied.get("id") else None
    if not row or not row["active"]:
        raise HttpError(401, "Sign in again.")
    return await present_person(db, row)


async def present_person(db, person):
    grants = await db.all("""SELECT g.id, g.role, g.office_id, o.name AS office_name FROM role_grant g
        LEFT JOIN office o ON o.id = g.office_id WHERE g.person_id = ? AND g.deleted_at IS NULL""", person["id"])
    return {"id": person["id"], "displayName": person["display_name"], "email": person["sign_in_name"], "active": bool(person["active"]),
            "superAdmin": any(g["role"] == "super_admin" for g in grants), "admin": any(g["role"] == "admin" for g in grants),
            "seesEveryOffice": any(g["role"] in ("super_admin", "admin") for g in grants),
            "grants": [{"id": g["id"], "role": g["role"], "officeId": g["office_id"], "officeName": g["office_name"]} for g in grants]}


def sees_every_office(person):
    return bool(person and (person.get("superAdmin") or person.get("seesEveryOffice") or any(g["role"] in ("admin", "super_admin") for g in person.get("grants", []))))


def can_write(person, office_id):
    return person["superAdmin"] or any(g["role"] == "office_manager" and g["officeId"] == office_id for g in person["grants"])


def require_view(person, office_id):
    if not sees_every_office(person) and not any(g["officeId"] == office_id for g in person["grants"]):
        raise HttpError(404, "Office not found.")


def require_write(person, office_id):
    require_view(person, office_id)
    if not can_write(person, office_id):
        raise HttpError(403, "This sign-in can view the office. It cannot change the pantry.")


async def log(db, actor_id, action, entity_type, entity_id, office_id, summary):
    await db.run("INSERT INTO operation (id, actor_id, action, entity_type, entity_id, office_id, at, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", new_id(), actor_id, action, entity_type, entity_id, office_id, stamp(), summary)


async def settings(db):
    row = await db.get("SELECT weekend_weight, lookback_months FROM company_setting WHERE id = 1")
    return {"weekendWeight": row["weekend_weight"], "lookbackMonths": row["lookback_months"]}


async def office_by_id(db, office_id):
    return await db.get("SELECT * FROM office WHERE id = ?", office_id)


async def grant(db, actor_id, person_id, role, office_id):
    if role not in ROLES:
        raise ValueError("bad role")
    await db.run("INSERT INTO role_grant (id, person_id, role, office_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", new_id(), person_id, role, office_id, actor_id, stamp())


async def names_by_id(db):
    return {r["id"]: r["display_name"] for r in await db.all("SELECT id, display_name FROM person")}


async def seed_production(db):
    if await db.get("SELECT id FROM person LIMIT 1"):
        return
    email = intuitive_sign_in_name(os.getenv("SEED_SUPERADMIN_EMAIL", "Siddharth.Kalyani@intuitive.AI"))
    if not email:
        raise ValueError("SEED_SUPERADMIN_EMAIL must be an @intuitive.AI sign-in name.")
    name = clean_name(os.getenv("SEED_SUPERADMIN_NAME", "Siddharth Kalyani")) or "Siddharth Kalyani"
    oid = os.getenv("SEED_SUPERADMIN_OBJECT_ID", "").strip() or None
    if oid and not UUID.fullmatch(oid):
        raise ValueError("SEED_SUPERADMIN_OBJECT_ID must be a directory object id.")
    person_id = new_id()
    await db.run("INSERT INTO person (id, directory_object_id, sign_in_name, display_name, active) VALUES (?, ?, ?, ?, 1)", person_id, oid, email, name)
    await grant(db, person_id, person_id, "super_admin", None)
