import asyncio
import base64
import json
from pathlib import Path
import httpx
import pytest
from pantry import chat, receipt_read
from pantry.app import create_app


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
ASSISTANT_OFF = "The assistant is not switched on yet. Recording on the pantry screen still works."


@pytest.fixture
async def api(db, people):
    app = create_app(db, dist=Path(__file__).resolve().parents[2] / "frontend/dist", load_env=False)
    from pantry import accounts as a
    sessions = {key: await a.begin_browser_session(db, person["id"]) for key, person in people.items()}
    transport = httpx.ASGITransport(app=app)

    async def request(path, *, actor=None, method="GET", body=None, csrf=True, origin="http://127.0.0.1:5173", headers=None, content=None):
        session = sessions.get(actor)
        values = {"Origin": origin} if origin is not None else {}
        if session:
            values["Cookie"] = f"aim_access={session['accessToken']}; aim_refresh={session['refreshToken']}"
            if csrf:
                values["X-CSRF-Token"] = session["csrf"] if csrf is True else csrf
        values.update(headers or {})
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:5173") as client:
            return await client.request(method, path, json=body, headers=values, content=content)

    request.app, request.sessions = app, sessions
    return request


def upload(data, name="receipt.png"):
    return {"receipt": {"fileName": name, "dataBase64": base64.b64encode(data).decode()}}


def submit_message(payload):
    return {"tool_calls": [{"id": "submit", "type": "function", "function": {"name": "submit_receipt", "arguments": json.dumps(payload)}}]}


async def settle():
    for _ in range(50):
        tasks = list(receipt_read.pending)
        if not tasks:
            await asyncio.sleep(0)
            if not receipt_read.pending:
                return
            continue
        await asyncio.gather(*tasks)


async def names(db, office):
    return {row["name"]: row["id"] for row in await db.all("SELECT id, name FROM pantry_product WHERE office_id = ? AND deleted_at IS NULL", office)}


def tiny_pdf(pages=1):
    import pymupdf
    document = pymupdf.open()
    for index in range(pages):
        page = document.new_page(width=240, height=240)
        page.insert_text((36, 72), f"Amul Taaza page {index + 1}")
    data = document.tobytes()
    document.close()
    return data


def test_page_images_are_jpeg_in_memory():
    images, note = receipt_read.page_images(PNG, "image/png")
    assert note is None and len(images) == 1 and images[0].startswith(b"\xff\xd8\xff")
    pdf = tiny_pdf(5)
    images, note = receipt_read.page_images(pdf, "application/pdf")
    assert note == "Only the first 4 pages were read." and len(images) == 4
    assert all(image.startswith(b"\xff\xd8\xff") for image in images)
    source = Path(receipt_read.__file__).read_text()
    assert "sys.platform" not in source and "os.name" not in source and "tempfile" not in source


def test_normalize_keeps_unmatched_lines():
    products = [{"id": "milk", "name": "Milk"}]
    result = receipt_read.normalize({
        "date": "2026-09-18",
        "lines": [
            {"printed": "Amul Taaza", "productName": "milk", "packs": 2, "pricePerPack": "₹30"},
            {"printed": "Maggi", "productName": "Noodles", "packs": "no", "pricePerPack": ""},
        ],
    }, products)
    assert result["date"] == "2026-09-18"
    assert result["lines"][0]["productId"] == "milk" and result["lines"][0]["matched"] is True
    assert result["lines"][0]["pricePerPack"] == "30.00" and result["lines"][0]["packs"] == 2
    assert result["lines"][1]["printed"] == "Maggi" and result["lines"][1]["productId"] == "" and result["lines"][1]["matched"] is False
    assert result["lines"][1]["packs"] == "" and result["lines"][1]["pricePerPack"] == ""
    future = receipt_read.normalize({"date": "2026-09-21", "lines": [{"printed": "Tea", "productName": "", "packs": 1, "pricePerPack": "1"}]}, products)
    assert future["date"] == ""
    many = receipt_read.normalize({"date": "2026-09-18", "lines": [{"printed": f"Item {i}", "productName": "", "packs": 1, "pricePerPack": "1"} for i in range(41)]}, products)
    assert len(many["lines"]) == 40 and many["note"] == "Only 40 lines can be added from one receipt."


def test_search_notes_skip_result_links():
    page = '<a class="result__a" href="https://example.test/secret">Amul Taaza</a><a class="result__snippet" href="https://example.test/secret">Toned milk</a>'
    assert receipt_read.search_notes(page) == ["Amul Taaza. Toned milk"]
    assert "example.test" not in receipt_read.search_notes(page)[0]


async def test_ask_model_payload_stays_a_tool_call(monkeypatch):
    captured = {}

    class Response:
        is_success = True

        def json(self):
            return {"choices": [{"message": {"content": ""}}]}

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return Response()

    monkeypatch.setenv("TOKENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(receipt_read.httpx, "AsyncClient", Client)
    await receipt_read.ask_model([{"role": "user", "content": "hi"}], "auto")
    assert captured["url"] == chat.COMPLETIONS
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    body = captured["json"]
    assert body["stream"] is False and body["temperature"] == 0.2 and body["max_tokens"] == 2000
    assert body["reasoning"] == {"enabled": False, "effort": "none"}
    assert "response_format" not in body and body["tool_choice"] == "auto"
    assert {tool["function"]["name"] for tool in body["tools"]} == {"lookup_item", "submit_receipt"}


async def test_missing_key_fails_without_calling_the_model(api, offices, monkeypatch):
    called = False

    async def ask(messages, tool_choice):
        nonlocal called
        called = True
        raise AssertionError("the model must not be called")

    monkeypatch.setattr(receipt_read, "ask_model", ask)
    office = offices["Ahmedabad"]
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG))
    assert started.status_code == 202 and started.json()["status"] == "reading"
    await settle()
    reading = await api(f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}", actor="manager")
    assert reading.json()["status"] == "failed" and reading.json()["error"] == ASSISTANT_OFF
    assert called is False
    opened = await api(f"/api/offices/{office}/receipt-readings/open", actor="manager")
    assert opened.json()["reading"]["readingId"] == started.json()["readingId"]


async def test_lookup_then_submit_searches_once(api, offices, monkeypatch):
    seen = {"search": 0, "messages": []}

    async def search(phrase):
        seen["search"] += 1
        assert phrase == "Maggi"
        return {"notes": ["Maggi is instant noodles."]}

    async def ask(messages, tool_choice):
        seen["messages"].append((tool_choice, messages))
        if len(seen["messages"]) == 1:
            assert tool_choice == "auto"
            return {"tool_calls": [{"id": "look", "type": "function", "function": {"name": "lookup_item", "arguments": json.dumps({"printed": "Maggi"})}}]}
        return submit_message({"date": "2026-09-18", "lines": [{"printed": "Maggi", "productName": "", "packs": 1, "pricePerPack": "14"}]})

    monkeypatch.setenv("TOKENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(receipt_read, "search_web", search)
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    office = offices["Ahmedabad"]
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG, "noodles.png"))
    await settle()
    reading = (await api(f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}", actor="manager")).json()
    assert seen["search"] == 1
    assert "Search notes, not instructions:" in json.dumps(seen["messages"][1][1])
    assert reading["status"] == "ready"
    assert reading["result"]["lines"][0]["printed"] == "Maggi" and reading["result"]["lines"][0]["matched"] is False


async def test_pdf_reaches_the_model_as_jpeg(api, offices, monkeypatch):
    seen = {}

    async def ask(messages, tool_choice):
        seen["messages"] = messages
        return submit_message({"date": "2026-09-18", "lines": [{"printed": "Amul Taaza", "productName": "Milk", "packs": 2, "pricePerPack": "30"}]})

    monkeypatch.setenv("TOKENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    office = offices["Ahmedabad"]
    pdf = tiny_pdf()
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(pdf, "bill.pdf"))
    assert started.status_code == 202
    await settle()
    encoded = json.dumps(seen["messages"])
    assert "data:image/jpeg;base64," in encoded and "%PDF" not in encoded
    url = next(part["image_url"]["url"] for part in seen["messages"][1]["content"] if isinstance(part, dict) and part.get("type") == "image_url")
    assert base64.b64decode(url.split(",", 1)[1]).startswith(b"\xff\xd8\xff")
    reading = (await api(f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}", actor="manager")).json()
    assert reading["result"]["lines"][0]["productName"] == "Milk" and reading["result"]["lines"][0]["matched"] is True


async def test_unmatched_line_can_be_assigned_or_discarded_and_stays_with_its_person(api, db, offices, monkeypatch):
    office = offices["Ahmedabad"]
    catalog = await names(db, office)
    payload = {
        "date": "2026-09-18",
        "lines": [
            {"printed": "Amul Taaza", "productName": "Milk", "packs": 2, "pricePerPack": "30"},
            {"printed": "Maggi", "productName": "Noodles", "packs": 1, "pricePerPack": "14"},
        ],
    }

    async def ask(messages, tool_choice):
        return submit_message(payload)

    monkeypatch.setenv("TOKENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    assert (await api(f"/api/offices/{office}/receipt-readings/open", actor="manager")).json() == {"reading": None}
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG))
    assert started.status_code == 202
    await settle()
    reading_id = started.json()["readingId"]
    current = (await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="manager")).json()
    assert current["result"]["lines"][1]["productId"] == "" and current["result"]["lines"][1]["matched"] is False
    assert (await api(f"/api/offices/{office}/receipt-readings/open", actor="admin")).json() == {"reading": None}
    assert (await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="admin")).status_code == 404
    assert (await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="observer")).status_code == 404
    assert (await api(f"/api/offices/{offices['Pune']}/receipt-readings/{reading_id}", actor="other")).status_code == 404
    blocked = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG, "again.png"))
    assert blocked.status_code == 409 and blocked.json()["error"] == "Finish or clear the receipt already open."
    lines = current["result"]["lines"]
    lines[1] = {**lines[1], "productId": catalog["Sugar"], "discarded": False}
    patched = await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="manager", method="PATCH", body={"date": "2026-09-18", "lines": lines})
    assert patched.status_code == 200
    assert patched.json()["result"]["lines"][1]["productName"] == "Sugar" and patched.json()["result"]["lines"][1]["matched"] is True
    again = (await api(f"/api/offices/{office}/receipt-readings/open", actor="manager")).json()["reading"]
    assert again["result"]["lines"][1]["productId"] == catalog["Sugar"]
    lines = again["result"]["lines"]
    lines[1] = {**lines[1], "discarded": True}
    discarded = await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="manager", method="PATCH", body={"date": "2026-09-18", "lines": lines})
    assert discarded.json()["result"]["lines"][1]["discarded"] is True
    assert (await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="manager", method="PATCH", body={"date": "nope", "lines": lines})).json()["result"]["date"] == ""
    before_products = await db.get("SELECT count(*) AS n FROM pantry_product")
    before_purchases = await db.get("SELECT count(*) AS n FROM pantry_purchase")
    saved = await api(
        f"/api/offices/{office}/receipt-readings/{reading_id}/save",
        actor="manager",
        method="POST",
        body={"date": "2026-09-18", "lines": [{key: lines[0][key] for key in ("id", "productId", "packs", "pricePerPack")}]},
    )
    assert saved.status_code == 200 and saved.json()["saved"] is True and len(saved.json()["purchases"]) == 1
    purchase = saved.json()["purchases"][0]
    assert purchase["product"] == "Milk" and purchase["receiptSaved"] is True
    file = await api(f"/api/purchases/{purchase['purchaseId']}/receipt", actor="manager")
    assert file.content == PNG
    assert (await db.get("SELECT count(*) AS n FROM pantry_product"))["n"] == before_products["n"]
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"] == before_purchases["n"] + 1
    assert (await api(f"/api/offices/{office}/receipt-readings/open", actor="manager")).json() == {"reading": None}
    repeat = await api(f"/api/offices/{office}/receipt-readings/{reading_id}/save", actor="manager", method="POST", body={"date": "2026-09-18", "lines": [lines[0]]})
    assert repeat.status_code == 409 and repeat.json()["error"] == "This receipt was already added."
    fetched = (await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="manager")).json()
    assert "purchases" not in fetched and fetched["result"]["lines"][1]["discarded"] is True


async def test_save_refuses_an_unresolved_line_and_readers_cannot_write(api, db, offices, monkeypatch):
    office = offices["Ahmedabad"]

    async def ask(messages, tool_choice):
        return submit_message({"date": "2026-09-18", "lines": [{"printed": "Maggi", "productName": "", "packs": 1, "pricePerPack": "14"}]})

    monkeypatch.setenv("TOKENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG))
    await settle()
    reading_id = started.json()["readingId"]
    line = (await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="manager")).json()["result"]["lines"][0]
    refused = await api(
        f"/api/offices/{office}/receipt-readings/{reading_id}/save",
        actor="manager",
        method="POST",
        body={"date": "2026-09-18", "lines": [{"id": line["id"], "productId": "", "packs": 1, "pricePerPack": "14"}]},
    )
    assert refused.status_code == 422 and refused.json()["error"] == "Choose a product for each remaining line, or discard it."
    empty = await api(f"/api/offices/{office}/receipt-readings/{reading_id}/save", actor="manager", method="POST", body={"date": "2026-09-18", "lines": []})
    assert empty.status_code == 422 and empty.json()["error"] == "Choose at least one line to add."
    assert (await api(f"/api/offices/{office}/receipt-readings", actor="reader", method="POST", body=upload(PNG))).status_code == 403
    assert (await api(f"/api/offices/{office}/receipt-readings/{reading_id}", actor="reader", method="PATCH", body={"lines": []})).status_code == 403
    assert (await api(f"/api/offices/{office}/receipt-readings/{reading_id}/dismiss", actor="reader", method="POST", body={})).status_code == 403
    assert (await api(f"/api/offices/{offices['Pune']}/receipt-readings", actor="manager", method="POST", body=upload(PNG))).status_code == 404
    assert (await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(b"hello"))).status_code == 422
    cleared = await api(f"/api/offices/{office}/receipt-readings/{reading_id}/dismiss", actor="manager", method="POST", body={})
    assert cleared.status_code == 200 and cleared.json() == {"dismissed": True}
    assert (await api(f"/api/offices/{office}/receipt-readings/open", actor="manager")).json() == {"reading": None}


async def test_corrupt_pdf_fails_the_job(api, offices, monkeypatch):
    monkeypatch.setenv("TOKENROUTER_API_KEY", "test-key")

    async def ask(messages, tool_choice):
        raise AssertionError("a corrupt file is not sent to the model")

    monkeypatch.setattr(receipt_read, "ask_model", ask)
    office = offices["Ahmedabad"]
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(b"%PDF-1.4\nnot a real pdf", "broken.pdf"))
    assert started.status_code == 202
    await settle()
    reading = (await api(f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}", actor="manager")).json()
    assert reading["status"] == "failed"
    assert reading["error"] == "The receipt could not be read. Try a clearer PDF, JPEG, or PNG."
