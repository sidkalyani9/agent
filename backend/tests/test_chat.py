import asyncio
import json
from datetime import timedelta
import httpx
import pytest
from pantry import core as c, conversations as conv, chat, inventory as inv, accounts as a
from .test_accounts import fails


async def test_proposals_are_owned_expiring_and_bound_to_thread(db, people, offices):
    manager = people["manager"]
    one = await conv.create_chat_thread(db, manager)
    two = await conv.create_chat_thread(db, manager)
    result = await chat.converse(db, manager, [], "delete coffee at Ahmedabad", thread_id=one["id"])
    proposal = result["proposals"][0]
    assert "will be deleted" in result["reply"] and not result["saved"]
    assert not (await chat.converse(db, manager, [], "yes", thread_id=two["id"]))["saved"]
    with fails(404):
        await conv.confirm_proposal(db, people["other"], proposal["id"], one["id"])
    with fails(404):
        await conv.confirm_proposal(db, manager, proposal["id"], two["id"])
    await conv.add_chat_message(db, manager, one["id"], "assistant", result["reply"], result["proposals"])
    assert (await conv.get_chat_thread(db, manager, one["id"]))["messages"][0]["proposals"]
    future = c.now() + timedelta(minutes=30)
    c.set_clock(lambda: future)
    with fails(404):
        await conv.confirm_proposal(db, manager, proposal["id"], one["id"])
    assert (await conv.get_chat_thread(db, manager, one["id"]))["messages"][0]["proposals"] == []


async def test_delete_no_yes_and_read_only_actor(db, people, offices):
    manager = people["manager"]
    first = await chat.converse(db, manager, [], "delete coffee at Ahmedabad")
    assert first["proposals"]
    assert (await chat.converse(db, manager, [], "no"))["reply"] == "Left unsaved."
    assert any(p["name"] == "Coffee" and not p["deletedAt"] for p in (await inv.get_pantry(db, manager, offices["Ahmedabad"]))["products"])
    assert not (await chat.converse(db, people["reader"], [], "delete coffee at Ahmedabad"))["proposals"]
    await chat.converse(db, manager, [], "delete coffee at Ahmedabad")
    assert (await chat.converse(db, manager, [], "yes"))["saved"]
    product = await db.get("SELECT id, deleted_at FROM pantry_product WHERE office_id = ? AND name = 'Coffee'", offices["Ahmedabad"])
    assert product["deleted_at"]
    for table in ("pantry_purchase", "pantry_count"):
        assert (await db.get(f"SELECT count(*) AS n FROM {table} WHERE product_id = ? AND deleted_at IS NULL", product["id"]))["n"] == 0


@pytest.mark.parametrize("message,table", [("delete the coffee purchase of 10 packs on 8 September at Ahmedabad", "pantry_purchase"), ("delete the coffee shelf count on 20 September at Ahmedabad", "pantry_count")])
async def test_single_row_delete_requires_yes(db, people, offices, message, table):
    before = (await db.get(f"SELECT count(*) AS n FROM {table} WHERE deleted_at IS NULL"))["n"]
    result = await chat.converse(db, people["manager"], [], message)
    assert result["proposals"], result
    assert (await db.get(f"SELECT count(*) AS n FROM {table} WHERE deleted_at IS NULL"))["n"] == before
    assert (await chat.converse(db, people["manager"], [], "yes"))["saved"]
    assert (await db.get(f"SELECT count(*) AS n FROM {table} WHERE deleted_at IS NULL"))["n"] == before - 1


async def test_factual_followup_and_temporary_closure_do_not_call_model(db, people, offices, monkeypatch):
    async def no_model(*args):
        raise AssertionError("A factual query must not call the provider")
    monkeypatch.setattr(chat, "complete", no_model)
    monkeypatch.setenv("TOKENROUTER_API_KEY", "synthetic-test-key")
    pantry = await inv.get_pantry(db, people["manager"], offices["Ahmedabad"])
    coffee = next(p for p in pantry["products"] if p["name"] == "Coffee")
    question = "how much coffee is left at Ahmedabad?"
    reply = await chat.converse(db, people["manager"], [], question)
    assert coffee["onHand"] in reply["reply"]
    history = [{"role": "user", "content": question}, {"role": "assistant", "content": reply["reply"]}]
    closed = await chat.converse(db, people["manager"], history, "When does it run out if the office is shut for 3 more working days?")
    assert "pantry screen stays" in closed["reply"]
    assert await inv.get_pantry(db, people["manager"], offices["Ahmedabad"]) == pantry


async def test_model_tool_loop_prepares_then_confirms_and_suppresses_premature_saved_claim(db, people, offices, monkeypatch):
    monkeypatch.setenv("TOKENROUTER_API_KEY", "synthetic-test-key")
    calls = []
    async def model(messages, can_write, on_delta):
        calls.append(messages.copy())
        assert can_write
        if len(calls) == 1:
            return {"content": "", "tool_calls": [{"id": "tool1", "type": "function", "function": {"name": "propose_purchase", "arguments": json.dumps({"office": "Ahmedabad", "product": "Coffee", "packs": 2, "pricePerPack": 10})}}]}
        assert messages[-1]["role"] == "tool"
        return {"content": "I have added the purchase. Done."}
    monkeypatch.setattr(chat, "complete", model)
    count = (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"]
    pieces, replacements = [], []
    result = await chat.converse(db, people["manager"], [], "Add 2 packs of coffee at Ahmedabad for 10 each", on_delta=pieces.append, on_replace=replacements.append)
    assert result["proposals"] and "not saved yet" in result["reply"]
    assert "".join(pieces) == result["reply"] and len(pieces) > 1
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"] == count
    assert (await chat.converse(db, people["manager"], [], "yes"))["saved"]
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"] == count + 1


async def test_model_call_rechecks_live_grants(db, people, monkeypatch):
    monkeypatch.setenv("TOKENROUTER_API_KEY", "synthetic-test-key")
    calls = 0
    async def model(messages, can_write, on_delta):
        nonlocal calls
        calls += 1
        if calls == 1:
            manager = people["manager"]
            await a.remove_grant(db, people["admin"], manager["id"], manager["grants"][0]["id"])
            return {"tool_calls": [{"id": "tool1", "function": {"name": "propose_product", "arguments": '{"office":"Ahmedabad","name":"Unauthorized"}'}}]}
        assert "error" in json.loads(messages[-1]["content"])
        return {"content": "That could not be prepared."}
    monkeypatch.setattr(chat, "complete", model)
    result = await chat.converse(db, people["manager"], [], "Add a product called Unauthorized at Ahmedabad")
    assert result["proposals"] == []
    assert not await db.get("SELECT id FROM pantry_product WHERE name = 'Unauthorized'")


async def test_streaming_provider_tool_fragments_and_http_failure(monkeypatch):
    monkeypatch.setenv("TOKENROUTER_API_KEY", "synthetic-test-key")
    real_client = httpx.AsyncClient
    captured = []
    def handler(request):
        captured.append(json.loads(request.content))
        frames = [{"content": "Hello "}, {"content": "world."}, {"tool_calls": [{"index": 0, "id": "a", "function": {"name": "get_", "arguments": '{"office":'}}]}, {"tool_calls": [{"index": 0, "function": {"name": "pantry", "arguments": '"Ahmedabad"}'}}]}]
        content = "\n".join("data: " + json.dumps({"choices": [{"delta": frame}]}) + "\n" for frame in frames) + "data: [DONE]\n"
        return httpx.Response(200, text=content, headers={"content-type": "text/event-stream"})
    monkeypatch.setattr(chat.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    pieces = []
    result = await chat.complete([{"role": "user", "content": "hello"}], False, pieces.append)
    assert "".join(pieces) == "Hello world."
    assert result["tool_calls"][0]["function"] == {"name": "get_pantry", "arguments": '{"office":"Ahmedabad"}'}
    assert not any(t["function"]["name"].startswith("propose_") for t in captured[0]["tools"])
    assert captured[0]["stream"] is True and captured[0]["model"] == chat.model_name()
    monkeypatch.setattr(chat.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(lambda _: httpx.Response(503, json={"private": "upstream secret"})), **kwargs))
    with fails(502, "could not reply"):
        await chat.complete([], False, None)
