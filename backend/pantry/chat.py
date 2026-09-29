"""Deterministic pantry replies, guarded proposals and optional model streaming."""
import asyncio
import calendar
import json
import logging
import os
import re
from datetime import date
from pathlib import Path
import httpx
from .core import HttpError, chat_thread
from .compat import text as js_text, number, dumps
from . import conversations as c
from . import inventory as inv
from .calc import add_days, project_run_out, today_in_india

COMPLETIONS = "https://api.tokenrouter.com/v1/chat/completions"
TOOLS = json.loads(Path(__file__).with_name("chat_tools.json").read_text())
PROMPT = Path(__file__).with_name("chat_prompt.txt").read_text()
PRODUCT_NAMES = ["coffee", "milk", "sugar", "tea", "sticks"]
READ = r"\b(left|on hand|run out|runs out|running out|how much|how many|when|spend|spent|burn|due|forecast|expected)\b"
MONTHS = [calendar.month_name[i].lower() for i in range(1, 13)]
logger = logging.getLogger(__name__)


def matches(pattern, text):
    return bool(re.search(pattern, text, re.I))


def model_name():
    return os.getenv("TOKENROUTER_MODEL") or os.getenv("OPENROUTER_MODEL") or "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"


def api_key():
    return os.getenv("TOKENROUTER_API_KEY") or os.getenv("OPENROUTER_API_KEY") or ""


def chat_configured():
    return bool(api_key())


async def system_prompt(db, person):
    snap = await c.snapshot_for_chat(db, person)
    prompt = PROMPT.replace("${person.displayName}", person["displayName"]).replace("${person.email}", person["email"]).replace("${snap.role}", snap["role"]).replace("${todayInIndia()}", today_in_india()).replace('${snap.lines.join("\\n")}', "\n".join(snap["lines"]))
    start = '${snap.canWriteSomewhere ? "This person may prepare pantry writes and deletes for the offices they manage." : "This person can look, and cannot prepare a write or a delete. Do not call propose tools."}'
    return prompt.replace(start, "This person may prepare pantry writes and deletes for the offices they manage." if snap["canWriteSomewhere"] else "This person can look, and cannot prepare a write or a delete. Do not call propose tools.")


async def run_tool(db, person, name, args):
    try:
        if name == "list_offices":
            return {"offices": await inv.list_offices(db, person)}
        if name in ("get_pantry", "list_activity"):
            office = await c.resolve_office(db, person, args.get("office"))
            if name == "get_pantry":
                return await inv.get_pantry(db, person, office["id"], args.get("month"), series=False)
            return {"activity": await inv.list_operations(db, person, office["id"])}
        actions = {"propose_product": "create_product", "propose_purchase": "add_purchase", "propose_count": "add_count"}
        if name in actions:
            return await c.create_proposal(db, person, actions[name], args)
        if name == "propose_delete":
            target = js_text(args.get("target") or "product")
            action = "delete_purchase" if target == "purchase" else "delete_count" if target == "count" else "delete_product"
            return await c.create_proposal(db, person, action, args)
        return {"error": "That action is not available. The assistant cannot hide, restore, or correct."}
    except Exception as error:
        return {"error": error.message if isinstance(error, HttpError) else "That could not be prepared."}


def scope_reply(text):
    lower = js_text(text or "").lower()
    if matches(r"\b(hide|restore|unhide)\b|^\s*(please\s+)?hide\b", lower):
        return "The assistant cannot hide or restore a record."
    if matches(r"\b(rename|correct|weekend weight|change (a |the )?role)\b", lower):
        return "The assistant cannot rename, correct, or change a role."
    if matches(r"\b(delete|remove|erase|wipe|destroy|drop)\b", lower) and matches(r"\b(everything|all products|all records|database|every product|the office|this office)\b", lower):
        return "The assistant cannot delete an office or every record at once. Name one pantry item."
    if matches(r"\breceipt\b", lower) and matches(r"\b(delete|remove|erase)\b", lower):
        return "The assistant cannot remove a receipt on its own."
    stock = matches(r"\b(coffee|milk|sugar|tea|sticks|pack|stock|burn|purchase|count|spend|on hand|run out|reorder|receipt|pantry)\b", lower)
    elsewhere = matches(r"\b(weather|rain|snow|joke|poem|lyrics|bitcoin|crypto|football|cricket|movie|recipe|president|capital of)\b", lower)
    if elsewhere and not stock:
        return "I only answer questions about this pantry: stock on hand, purchases, counts, spend, burn rate, and when a product is expected to run out."
    return ""


def visible(value):
    return re.sub(r"<think>[\s\S]*?</think>", "", js_text(value or ""), flags=re.I).strip()


def safe_text(text, proposals):
    cleaned = visible(text)
    if any(js_text(p.get("action") or "").startswith("delete_") for p in proposals):
        summary = " ".join(re.sub(r"\.$", "", js_text(p.get("summary") or "")) for p in proposals)
        return f"{summary} will be deleted. Say yes and I'll do it."
    if proposals:
        claimed = matches(r"saved|recorded|i'?ve added|i have added|done\.|already entered", cleaned)
        if not cleaned or claimed:
            return f"{' '.join(p['summary'] for p in proposals)} This is not saved yet. Confirm the card and it will be entered."
        return cleaned
    return cleaned or "I could not read a reply from the model. Ask again, or use the pantry screen."


def reply_text(message):
    parts = []
    content = message.get("content")
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and part.get("type") != "reasoning":
                parts.append(part.get("text") or part.get("content") or "")
    for detail in message.get("reasoning_details") or []:
        if detail.get("type") != "reasoning.text":
            parts.append(detail.get("text") or detail.get("summary") or "")
    direct = visible("\n".join(parts))
    if direct:
        return direct
    reasoning = visible(message.get("reasoning") or message.get("reasoning_content"))
    sentences = [line for line in re.split(r"(?<=[.?!])\s+", reasoning) if matches(r"\d|pack|₹", line) and not matches(r"^okay\b", line)]
    return " ".join(sentences[-2:])


def named_products(text):
    return [name for name in PRODUCT_NAMES if name in js_text(text or "").lower()]


def named_office(offices, text):
    return next((o for o in offices if o["name"].lower() in js_text(text or "").lower()), None)


def india_long(iso):
    if not iso:
        return ""
    value = date.fromisoformat(iso)
    return f"{value.day} {calendar.month_name[value.month]} {value.year}"


def rupee(value):
    # Intl en-IN grouping: 12,34,567.89.
    value = number(value or 0)
    sign = "-" if value < 0 else ""
    whole, fraction = f"{abs(value):.2f}".split(".")
    if len(whole) > 3:
        prefix, tail = whole[:-3], whole[-3:]
        groups = []
        while prefix:
            groups.insert(0, prefix[-2:])
            prefix = prefix[:-2]
        whole = ",".join(groups + [tail])
    return f"{sign}₹{whole}.{fraction}"


def month_title(month):
    year, mon = map(int, month.split("-"))
    return f"{calendar.month_name[mon]} {year}"


def closed_working_days(text):
    for pattern in [r"(\d+)\s+more\s+working\s+days", r"shut\s+for\s+(\d+)", r"closed?\s+for\s+(\d+)", r"(\d+)\s+extra\s+(?:leave|leaves|working\s+days|holidays)"]:
        hit = re.search(pattern, js_text(text or ""), re.I)
        if hit:
            return int(hit[1])
    return 0


def describe_product(office_name, product, month, question):
    spend = matches(r"\b(spend|spent|price|cost)\b", question)
    stock = matches(r"\b(left|on hand|how much|how many|run out|runs out|when|burn|due|expected|forecast)\b", question) or not spend
    lines = []
    if stock:
        lines.append(f"{product['name']} at {office_name} has {product['onHand']} packs on hand.")
        if product["burnRatePerEffectiveDay"]:
            lines.append(f"The burn rate is {product['burnRatePerEffectiveDay']} packs per effective day.")
        if product["expectedDate"]:
            closed = closed_working_days(question)
            if closed > 0:
                adjusted = project_run_out(today=product["today"], onHand=product["onHand"], burn=product["burnRatePerEffectiveDay"], reorderLevel=product["reorderLevel"], weekendWeight=product["weekendWeight"], closedWeekdays=closed)
                lines.append(f"With the office shut for {closed} more working days, it is expected to run out on {india_long(adjusted['expectedDate'])}. The date on the pantry screen stays {india_long(product['expectedDate'])}.")
            else:
                lines.append(f"It is expected to run out on {india_long(product['expectedDate'])}.")
        elif product["message"]:
            lines.append(product["message"])
    if spend:
        lines.append(f"{office_name} has spent {rupee(product['spend'])} on {product['name']} in {month_title(month)}.")
    return " ".join(lines)


async def factual_reply(db, person, text, history=None):
    if not matches(READ, text):
        return ""
    offices = await inv.list_offices(db, person)
    earlier = "\n".join(item.get("content") or "" for item in history or [])
    office = named_office(offices, text) or (offices[0] if len(offices) == 1 else named_office(offices, earlier))
    products = named_products(text) or named_products(earlier)[-1:]
    if not office:
        return "Which office should I use?"
    spend = matches(r"\b(spend|spent|price|cost)\b", text)
    stock = matches(r"\b(left|on hand|how much|how many|run out|runs out|when|burn|due|expected|forecast)\b", text)
    if not products and stock and not spend:
        return "Which product should I use?"
    try:
        pantry = await inv.get_pantry(db, person, office["id"], series=False)
    except Exception as error:
        return error.message if isinstance(error, HttpError) else ""
    if not products and spend:
        return f"{office['name']} has spent {rupee(pantry['spend'])} in {month_title(pantry['month'])}."
    lines = []
    for name in products:
        product = next((p for p in pantry["products"] if p["name"].lower() == name and not p["deletedAt"]), None)
        lines.append(describe_product(office["name"], {**product, "today": pantry["today"], "weekendWeight": pantry["settings"]["weekendWeight"]}, pantry["month"], text) if product else f"{name} is not on the {office['name']} pantry.")
    return " ".join(filter(None, lines))


def is_delete_request(text):
    if matches(r"^\s*(please\s+)?(do not|don't|dont|no)\b|\b(hide|restore|unhide|rename|correct|receipt)\b|\b(everything|all products|all records|database|every product|the office|this office)\b", text):
        return False
    return matches(r"\b(delete|remove|erase)\b|\btake\b[\s\S]{0,40}\boff\b", text)


def named_date(text, today):
    hit = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", text)
    if hit:
        return hit[1]
    if matches(r"\btoday\b", text):
        return today
    if matches(r"\byesterday\b", text):
        return add_days(today, -1)
    for month, name in enumerate(MONTHS, 1):
        short = name[:3]
        if matches(rf"\b{name}\b|\b{short}t?\b", text):
            year_hit = re.search(r"\b(20\d{2})\b", text)
            year = year_hit[1] if year_hit else today[:4]
            hit = next((m for p in [rf"\b(\d{{1,2}})\s+{name}\b", rf"\b(\d{{1,2}})\s+{short}t?\b", rf"\b{name}\s+(\d{{1,2}})\b", rf"\b{short}t?\s+(\d{{1,2}})\b"] if (m := re.search(p, text, re.I))), None)
            day = int(hit[1]) if hit else 0
            return f"{year}-{month:02d}-{day:02d}" if 1 <= day <= 31 else ""
    return ""


def present_proposal(row):
    return {"id": row.get("proposalId") or row["id"], "summary": row["summary"], "action": row["action"]}


def response(reply, proposals=None, saved=False):
    return {"reply": reply, "proposals": proposals or [], "saved": saved}


async def delete_reply(db, person, text):
    if not is_delete_request(text):
        return None
    if not (await c.snapshot_for_chat(db, person))["canWriteSomewhere"]:
        return response("You can look at the pantry. You cannot delete an item.")
    try:
        offices = await inv.list_offices(db, person)
        office = named_office(offices, text)
        if not office and len(offices) != 1:
            return response("Which office should I use?")
        office = office or offices[0]
        pantry = await inv.get_pantry(db, person, office["id"], series=False)
        names = [p["name"] for p in pantry["products"] if not p["deletedAt"]]
        hits = [name for name in names if name.lower() in text.lower()]
        if len(hits) != 1:
            return response(f"I can delete one item at a time. Which one: {' or '.join(hits)}?" if hits else f"Which product should I delete? {', '.join(names)}.")
        purchase = matches(r"\bpurchases?\b|\bbought\b", text)
        count = matches(r"\bcounts?\b|\bcounted\b|\bshelf count\b", text)
        if purchase and count:
            return response("Should I delete a purchase or a shelf count?")
        payload = {"office": office["name"], "product": hits[0]}
        action = "delete_purchase" if purchase else "delete_count" if count else "delete_product"
        if purchase or count:
            day = named_date(text, pantry["today"])
            packs = re.search(r"\b(\d+)\s+packs?\b", text, re.I)
            if day:
                payload["date"] = day
            if packs:
                payload["packs"] = int(packs[1])
        proposal = await c.create_proposal(db, person, action, payload)
        return response(f"{proposal['summary'].removesuffix('.')} will be deleted. Say yes and I'll do it.", [present_proposal(proposal)])
    except Exception as error:
        return response(error.message if isinstance(error, HttpError) else "That could not be prepared.")


async def reveal(text, emit):
    cursor = 0
    while cursor < len(text):
        next_index = min(len(text), cursor + 32)
        if next_index < len(text):
            space = text.rfind(" ", cursor, next_index + 1)
            if space > cursor + 8:
                next_index = space + 1
        emit(text[cursor:next_index])
        cursor = next_index
        if cursor < len(text):
            await asyncio.sleep(.016)


def stream_visible(content):
    content = re.sub(r"<think>[\s\S]*?</think>", "", content or "", flags=re.I)
    return re.sub(r"<think>[\s\S]*$", "", content, flags=re.I)


async def read_model_stream(upstream, on_delta):
    message = {"content": "", "reasoning": "", "tool_calls": []}
    calls, shown = {}, ""
    async for line in upstream.aiter_lines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            payload = json.loads(data)
        except ValueError:
            continue
        delta = (payload.get("choices") or [{}])[0].get("delta") or {}
        if isinstance(delta.get("content"), str):
            message["content"] += delta["content"]
        reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
        if isinstance(reasoning, str):
            message["reasoning"] += reasoning
        for call in delta.get("tool_calls") or []:
            index = call.get("index") if type(call.get("index")) is int else 0
            target = calls.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
            for key in ("id", "type"):
                if call.get(key):
                    target[key] = call[key]
            for key in ("name", "arguments"):
                target["function"][key] += (call.get("function") or {}).get(key) or ""
        next_text = stream_visible(message["content"])
        if next_text.startswith(shown) and len(next_text) > len(shown) and on_delta:
            on_delta(next_text[len(shown):])
            shown = next_text
    message["tool_calls"] = [calls[k] for k in sorted(calls) if calls[k]["function"]["name"]]
    return message


async def complete(messages, can_write, on_delta):
    payload = {"model": model_name(), "temperature": .2, "max_tokens": 1200, "messages": messages,
               "tools": TOOLS if can_write else [t for t in TOOLS if not t["function"]["name"].startswith("propose_")], "tool_choice": "auto"}
    if on_delta:
        payload["stream"] = True
    async with asyncio.timeout(90), httpx.AsyncClient(timeout=90) as client:
        async with client.stream("POST", COMPLETIONS, headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"}, json=payload) as upstream:
            if not upstream.is_success:
                logger.warning("Assistant upstream failed (%s).", upstream.status_code)
                raise HttpError(502, "The assistant could not reply. Try again in a moment.")
            if on_delta and "text/event-stream" in upstream.headers.get("content-type", ""):
                return await read_model_stream(upstream, on_delta)
            try:
                payload = json.loads(await upstream.aread())
            except ValueError:
                payload = {}
            return (payload.get("choices") or [{}])[0].get("message") or {}


async def converse(db, person, history, message, *, thread_id=None, on_delta=None, on_replace=None):
    token = chat_thread.set(thread_id or None)
    try:
        return await converse_in_thread(db, person, history, message, on_delta=on_delta, on_replace=on_replace)
    finally:
        chat_thread.reset(token)


async def converse_in_thread(db, person, history, message, *, on_delta=None, on_replace=None):
    text = js_text(message or "").strip()
    if not text:
        raise HttpError(422, "Write a message first.")
    if len(text) > 2000:
        raise HttpError(422, "Keep a message under 2000 characters.")
    streamed = ""
    def emit(piece):
        nonlocal streamed
        if piece:
            streamed += piece
            if on_delta:
                on_delta(piece)
    async def deliver(payload):
        if on_delta and payload.get("reply") and streamed != payload["reply"]:
            if not streamed:
                await reveal(payload["reply"], emit)
            elif on_replace:
                on_replace(payload["reply"])
        return payload
    pending = await c.latest_pending(db, person["id"])
    yes = matches(r"^(yes|yeah|yep|confirm|confirmed|do it|go ahead|okay|ok|sure|haan)\.?!?$", text)
    no = matches(r"^(no|nope|cancel|stop|don't|do not)\.?!?$", text)
    if pending and no:
        for item in pending:
            await c.dismiss_proposal(db, person, item["id"])
        return await deliver(response("Left unsaved."))
    if len(pending) == 1 and yes:
        saved = await c.confirm_proposal(db, person, pending[0]["id"])
        lead = "Deleted." if saved["action"].startswith("delete_") else "Saved."
        return await deliver(response(f"{lead} {saved['summary']}", saved=True))
    if len(pending) > 1 and yes:
        return await deliver(response("More than one card is waiting. Confirm the one you want on screen.", [present_proposal(p) for p in pending]))
    blocked = scope_reply(text)
    if blocked:
        return await deliver(response(blocked))
    deletion = await delete_reply(db, person, text)
    if deletion:
        return await deliver(deletion)
    known = await factual_reply(db, person, text, history)
    if known:
        return await deliver(response(known))
    if not api_key():
        return await deliver(response("The assistant is not switched on yet. Recording on the pantry screen still works."))
    can_write = (await c.snapshot_for_chat(db, person))["canWriteSomewhere"]
    messages = [{"role": "system", "content": await system_prompt(db, person)}, *[{"role": i["role"], "content": js_text(i.get("content") or "")[:2000]} for i in history[-10:]], {"role": "user", "content": text}]
    proposals, reply, last_pantry = [], "", None
    for _ in range(3):
        assistant = await complete(messages, can_write, emit if on_delta else None)
        calls = assistant.get("tool_calls") or []
        messages.append({"role": "assistant", "content": assistant["content"] if isinstance(assistant.get("content"), str) else reply_text(assistant), **({"tool_calls": calls} if calls else {})})
        if not calls:
            reply = safe_text(reply_text(assistant), proposals)
            if reply.startswith("I could not read a reply") and last_pantry:
                reply = await factual_reply(db, person, text, history) or reply
            break
        for call in calls:
            function = call.get("function") or {}
            try:
                args = json.loads(function.get("arguments") or "{}")
            except (ValueError, TypeError):
                args = {}
            result = await run_tool(db, person, function.get("name"), args)
            if function.get("name") == "get_pantry" and result and not result.get("error"):
                last_pantry = result
            if result.get("proposalId"):
                proposals.append(present_proposal(result))
            messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": dumps(result)})
        reply = safe_text("", proposals)
    return await deliver(response(reply, proposals))
