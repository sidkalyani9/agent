"""Owned chat history and expiring, thread-bound confirmations."""
import json
from datetime import timedelta
from .core import (HttpError, scoped, transactional, live_person, chat_thread, now, stamp, parse_stamp,
                   new_id, require_write)
from .compat import text, number, dumps
from .calc import today_in_india, format_when
from .inventory import (list_offices, parse_date, parse_packs, parse_price, create_product, create_purchase,
                        upsert_count, delete_product, delete_purchase, delete_count)

PROPOSALS = {"create_product", "add_purchase", "add_count", "delete_product", "delete_purchase", "delete_count"}


@scoped
async def resolve_office(db, person, name_or_id):
    person = await live_person(db, person)
    offices = await list_offices(db, person)
    query = text(name_or_id or "").strip().lower()
    if not query and len(offices) == 1:
        return offices[0]
    matches = [o for o in offices if o["id"] == name_or_id or o["name"].lower() == query or query in o["name"].lower()]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise HttpError(404, "Office not found.")
    raise HttpError(422, f"Which office: {', '.join(o['name'] for o in matches)}?")


async def resolve_product(db, office_id, name_or_id):
    products = await db.all("SELECT * FROM pantry_product WHERE office_id = ? AND deleted_at IS NULL", office_id)
    query = text(name_or_id or "").strip().lower()
    matches = [p for p in products if p["id"] == name_or_id or p["name"].lower() == query]
    if len(matches) == 1:
        return matches[0]
    raise HttpError(422, f"Which product at this office: {', '.join(p['name'] for p in products)}?")


async def store_proposal(db, person, action, payload, summary, office_id):
    proposal_id = new_id()
    await db.run("INSERT INTO proposal (id, person_id, action, payload, summary, office_id, created_at, status, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)", proposal_id, person["id"], action, dumps(payload), summary, office_id, stamp(), chat_thread.get())
    return {"proposalId": proposal_id, "summary": summary, "status": "pending_confirmation", "action": action}


@scoped
async def create_proposal(db, person, action, payload):
    person = await live_person(db, person)
    if action not in PROPOSALS:
        raise HttpError(403, "The assistant cannot hide, delete, restore, or correct a record.")
    office = await resolve_office(db, person, payload.get("office"))
    if action == "create_product":
        require_write(person, office["id"])
        name = text(payload.get("name") or "").strip()
        if not name:
            raise HttpError(422, "A product needs a name.")
        return await store_proposal(db, person, action, {"officeId": office["id"], "name": name}, f"Add product {name} at {office['name']}.", office["id"])
    if action.startswith("delete_"):
        require_write(person, office["id"])
        product = await resolve_product(db, office["id"], payload.get("product") or (payload.get("productId") if action != "delete_product" else None))
        if action == "delete_product":
            return await store_proposal(db, person, action, {"officeId": office["id"], "productId": product["id"]}, f"{product['name']} at {office['name']}, including its purchases and shelf counts.", office["id"])
        return await propose_row_delete(db, person, office, product, payload, "purchase" if action == "delete_purchase" else "count")
    product = await resolve_product(db, office["id"], payload.get("product"))
    require_write(person, office["id"])
    day = parse_date(payload.get("date") or today_in_india(now()))
    packs = parse_packs(payload.get("packs"), allow_zero=action == "add_count")
    stored = {"officeId": office["id"], "productId": product["id"], "date": day, "packs": packs}
    if action == "add_purchase":
        price = parse_price(payload.get("pricePerPack"))
        stored["pricePerPack"] = price
        summary = f"Enter {packs} packs of {product['name']} at {office['name']} on {day}, at ₹{price} per pack."
    else:
        summary = f"Count {packs} packs of {product['name']} on the shelf at {office['name']} on {day}."
    return await store_proposal(db, person, action, stored, summary, office["id"])


async def propose_row_delete(db, person, office, product, payload, kind):
    purchase = kind == "purchase"
    table, day_key = ("pantry_purchase", "purchased_on") if purchase else ("pantry_count", "counted_on")
    rows = await db.all(f"SELECT * FROM {table} WHERE product_id = ? AND deleted_at IS NULL ORDER BY {day_key}, created_at", product["id"])
    row_id = payload.get("purchaseId" if purchase else "countId")
    if row_id:
        rows = [r for r in rows if r["id"] == row_id]
    if payload.get("date"):
        rows = [r for r in rows if r[day_key] == payload["date"]]
    if payload.get("packs") is not None and payload["packs"] != "":
        rows = [r for r in rows if number(r["packs"]) == number(payload["packs"])]
    label = "purchase" if purchase else "shelf count"
    if len(rows) != 1:
        if not rows:
            raise HttpError(422, f"There is no matching {label} of {product['name']} at {office['name']}.")
        sample = "; ".join(f"{r['packs']} packs on {r[day_key]}" for r in rows[:6])
        more = f"; and {len(rows) - 6} more" if len(rows) > 6 else ""
        raise HttpError(422, f"Which {label} of {product['name']}: {sample}{more}?")
    row = rows[0]
    summary = f"The {label} of {row['packs']} packs of {product['name']} at {office['name']} on {row[day_key]}."
    return await store_proposal(db, person, f"delete_{kind}", {"officeId": office["id"], f"{kind}Id": row["id"]}, summary, office["id"])


_DEFAULT_THREAD = object()


@transactional
async def confirm_proposal(db, person, proposal_id, thread_id=_DEFAULT_THREAD):
    if thread_id is _DEFAULT_THREAD:
        thread_id = chat_thread.get()
    person = await live_person(db, person)
    proposal = await db.get("SELECT * FROM proposal WHERE id = ? AND person_id = ?", proposal_id, person["id"])
    if not proposal or proposal["status"] != "pending":
        raise HttpError(404, "That confirmation is no longer waiting.")
    if proposal["thread_id"] != thread_id or parse_stamp(proposal["created_at"]) + timedelta(minutes=30) <= now():
        raise HttpError(404, "That confirmation is no longer waiting in this chat.")
    action = proposal["action"]
    if action not in PROPOSALS:
        raise HttpError(403, "The assistant cannot hide, delete, restore, or correct a record.")
    payload = json.loads(proposal["payload"])
    if action == "create_product":
        result = await create_product(db, person, payload["officeId"], payload["name"])
    elif action == "add_purchase":
        result = await create_purchase(db, person, payload["officeId"], payload)
    elif action == "add_count":
        result = await upsert_count(db, person, payload["officeId"], payload)
    elif action == "delete_product":
        result = await delete_product(db, person, payload["productId"])
    elif action == "delete_purchase":
        result = await delete_purchase(db, person, payload["purchaseId"])
    else:
        result = await delete_count(db, person, payload["countId"])
    await db.run("UPDATE proposal SET status = 'confirmed' WHERE id = ?", proposal_id)
    return {"ok": True, "summary": proposal["summary"], "result": result, "action": action}


@scoped
async def dismiss_proposal(db, person, proposal_id):
    person = await live_person(db, person)
    proposal = await db.get("SELECT * FROM proposal WHERE id = ? AND person_id = ?", proposal_id, person["id"])
    if not proposal or proposal["status"] != "pending":
        raise HttpError(404, "That confirmation is no longer waiting.")
    await db.run("UPDATE proposal SET status = 'dismissed' WHERE id = ?", proposal_id)
    return {"ok": True}


@scoped
async def list_chat_threads(db, person):
    person = await live_person(db, person)
    return [{"id": r["id"], "title": r["title"], "updatedAt": r["updated_at"], "updatedAtLabel": format_when(r["updated_at"])} for r in await db.all("SELECT * FROM chat_thread WHERE person_id = ? ORDER BY updated_at DESC LIMIT 40", person["id"])]


@scoped
async def create_chat_thread(db, person):
    person = await live_person(db, person)
    thread_id, at = new_id(), stamp()
    await db.run("INSERT INTO chat_thread (id, person_id, title, created_at, updated_at) VALUES (?, ?, 'New chat', ?, ?)", thread_id, person["id"], at, at)
    return {"id": thread_id, "title": "New chat", "updatedAt": at, "updatedAtLabel": format_when(at)}


async def thread_for(db, person, thread_id):
    thread = await db.get("SELECT * FROM chat_thread WHERE id = ? AND person_id = ?", thread_id, person["id"])
    if not thread:
        raise HttpError(404, "That chat was not found.")
    return thread


@scoped
async def get_chat_thread(db, person, thread_id):
    person = await live_person(db, person)
    thread = await thread_for(db, person, thread_id)
    messages = []
    for row in await db.all("SELECT * FROM chat_message WHERE thread_id = ? ORDER BY created_at, rowid", thread_id):
        proposals = []
        for proposal in json.loads(row["proposals"] or "[]"):
            live = await db.get("SELECT status, created_at, thread_id, person_id FROM proposal WHERE id = ?", proposal["id"])
            if live and live["status"] == "pending" and live["person_id"] == person["id"] and live["thread_id"] == thread_id and parse_stamp(live["created_at"]) + timedelta(minutes=30) > now():
                proposals.append(proposal)
        messages.append({"id": row["id"], "role": row["role"], "content": row["content"], "proposals": proposals})
    return {"thread": {"id": thread["id"], "title": thread["title"], "updatedAtLabel": format_when(thread["updated_at"])}, "messages": messages}


@scoped
async def recent_chat_history(db, person, thread_id):
    person = await live_person(db, person)
    await thread_for(db, person, thread_id)
    return list(reversed(await db.all("SELECT role, content FROM chat_message WHERE thread_id = ? AND role IN ('user', 'assistant') ORDER BY created_at DESC, rowid DESC LIMIT 10", thread_id)))


@scoped
async def add_chat_message(db, person, thread_id, role, content, proposals=None):
    person = await live_person(db, person)
    thread = await thread_for(db, person, thread_id)
    at, message_id = stamp(), new_id()
    proposals = proposals or []
    await db.run("INSERT INTO chat_message (id, thread_id, role, content, proposals, created_at) VALUES (?, ?, ?, ?, ?, ?)", message_id, thread_id, role, content, dumps(proposals), at)
    import re
    title = (re.sub(r"\s+", " ", text(content)).strip()[:48] or "New chat") if thread["title"] == "New chat" and role == "user" else thread["title"]
    await db.run("UPDATE chat_thread SET title = ?, updated_at = ? WHERE id = ?", title, at, thread_id)
    return {"id": message_id, "role": role, "content": content, "proposals": proposals}


@scoped
async def latest_pending(db, person_id):
    return [r for r in await db.all("SELECT * FROM proposal WHERE person_id = ? AND status = 'pending' ORDER BY created_at DESC", person_id) if r["thread_id"] == chat_thread.get() and parse_stamp(r["created_at"]) + timedelta(minutes=30) > now()]


@scoped
async def snapshot_for_chat(db, person):
    person = await live_person(db, person)
    lines = []
    for office in await list_offices(db, person):
        names = [r["name"] for r in await db.all("SELECT name FROM pantry_product WHERE office_id = ? AND deleted_at IS NULL ORDER BY name", office["id"])]
        lines.append(f"{office['name']}: {', '.join(names) or 'no products'}")
    role = "Super Admin" if person["superAdmin"] else "; ".join(f"{g['role']} at {text(g['officeName'])}" for g in person["grants"])
    return {"role": role, "lines": lines, "canWriteSomewhere": person["superAdmin"] or any(g["role"] == "office_manager" for g in person["grants"])}
