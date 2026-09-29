import base64
import json
import re
from pathlib import Path
import httpx
import pytest
from pantry import core as c, accounts as a, conversations as conv, inventory as inv, chat
from pantry.app import create_app
from pantry.http import allowed_origin, client_ip, RateLimiter
from starlette.requests import Request
from .test_accounts import choose_password


@pytest.fixture
async def api(db, people):
    app = create_app(db, dist=Path(__file__).resolve().parents[2] / "frontend/dist", load_env=False)
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


async def test_route_surface_matches_node(api):
    expected = json.loads((Path(__file__).parent / "fixtures/http-routes.json").read_text())
    actual = sorted((method.upper(), re.sub(r"\{[^}]+\}", "{}", path)) for path, operations in api.app.openapi()["paths"].items() for method in operations if path.startswith("/api/"))
    assert actual == [tuple(row) for row in expected]


async def test_auth_csrf_roles_and_security_headers(api, offices):
    assert (await api("/api/offices")).status_code == 401
    assert (await api("/api/access", actor="manager")).status_code == 403
    assert (await api(f"/api/offices/{offices['Pune']}/pantry", actor="manager")).status_code == 404
    path = f"/api/offices/{offices['Ahmedabad']}/products"
    missing = await api(path, actor="admin", method="POST", body={"name": "No CSRF"}, csrf=False)
    assert missing.status_code == 403 and missing.json()["code"] == "csrf"
    assert (await api(path, actor="reader", method="POST", body={"name": "No rights"})).status_code == 403
    for origin in ("https://evil.example", "null"):
        assert (await api("/api/auth/refresh", actor="admin", method="POST", body={}, origin=origin)).status_code == 403
    assert (await api(path, actor="admin", method="POST", body={"name": "Cross site"}, headers={"Sec-Fetch-Site": "cross-site"})).status_code == 403
    me = await api("/api/me", actor="admin")
    assert me.json()["csrfToken"] == api.sessions["admin"]["csrf"] and me.json()["chatConfigured"] is False
    for name, value in {"x-content-type-options": "nosniff", "x-frame-options": "DENY", "cache-control": "no-store", "referrer-policy": "no-referrer"}.items():
        assert me.headers[name] == value
    assert "script-src 'self'" in me.headers["content-security-policy"]
    assert "x-powered-by" not in me.headers
    assert (await api("/api/unknown", actor="admin")).json() == {"error": "Not found."}
    assert (await api("/api/health/")).json() == {"ok": True}
    assert (await api("/api/health", method="HEAD")).content == b""


async def test_full_inventory_routes(api, offices):
    office = offices["Ahmedabad"]
    created = await api(f"/api/offices/{office}/products", actor="manager", method="POST", body={"name": "HTTP biscuits"})
    assert created.status_code == 201
    product = created.json()["productId"]
    assert (await api(f"/api/products/{product}", actor="manager", method="PATCH", body={"name": "HTTP biscuits edited", "reorderLevel": 2, "warningEffectiveDays": 7})).status_code == 200
    data = b"%PDF-1.4\nHTTP receipt\n%%EOF"
    receipt = {"fileName": "receipt.pdf", "dataBase64": base64.b64encode(data).decode()}
    body = {"productId": product, "date": "2026-09-20", "packs": 2, "pricePerPack": "12.50", "receipt": receipt}
    bought = await api(f"/api/offices/{office}/purchases", actor="manager", method="POST", body=body, headers={"Idempotency-Key": "http-save-key-001"})
    assert bought.status_code == 201 and bought.json()["receiptSaved"]
    purchase = bought.json()["purchaseId"]
    repeat = await api(f"/api/offices/{office}/purchases", actor="manager", method="POST", body=body, headers={"Idempotency-Key": "http-save-key-001"})
    assert repeat.json() == bought.json()
    file = await api(f"/api/purchases/{purchase}/receipt", actor="reader")
    assert file.content == data and file.headers["content-type"] == "application/pdf"
    assert file.headers["content-disposition"] == 'attachment; filename="receipt.pdf"'
    assert (await api(f"/api/purchases/{purchase}/receipt")).status_code == 401
    assert (await api(f"/api/purchases/{purchase}/receipt", actor="other")).status_code == 404
    listed = await api(f"/api/offices/{office}/purchases?month=2026-09", actor="reader")
    assert any(p["purchaseId"] == purchase and p["receiptName"] == "receipt.pdf" for p in listed.json()["purchases"])
    assert (await api(f"/api/purchases/{purchase}/receipt", actor="manager", method="PUT", body={"receipt": {**receipt, "fileName": "replacement.pdf"}})).json()["receiptSaved"]
    assert (await api(f"/api/purchases/{purchase}", actor="manager", method="PUT", body={"packs": 3})).status_code == 200
    count = (await api(f"/api/offices/{office}/counts", actor="manager", method="PUT", body={"productId": product, "date": "2026-09-20", "packs": 3})).json()["countId"]
    assert (await api(f"/api/counts/{count}/hide", actor="manager", method="POST", body={})).json()["hidden"]
    assert (await api(f"/api/purchases/{purchase}/hide", actor="manager", method="POST", body={})).json()["hidden"]
    for action in ("hide", "restore"):
        assert (await api(f"/api/products/{product}/{action}", actor="manager", method="POST", body={})).status_code == 200
    assert (await api(f"/api/offices/{office}/pantry?month=2026-09", actor="manager")).json()["canWrite"]
    assert "offices" in (await api("/api/pantry/summary?month=2026-09", actor="observer")).json()
    assert (await api(f"/api/offices/{office}/operations?from=2026-09-01&to=2026-09-20", actor="manager")).json()["operations"]
    csv = await api(f"/api/offices/{office}/export?month=2026-09", actor="reader")
    assert csv.content.startswith(b"\xef\xbb\xbf") and csv.headers["content-type"] == "text/csv; charset=utf-8"
    assert csv.headers["content-disposition"] == 'attachment; filename="Ahmedabad-2026-09.csv"'
    assert (await api("/api/settings", actor="admin", method="PATCH", body={"weekendWeight": .4, "lookbackMonths": 4})).json() == {"weekendWeight": .4, "lookbackMonths": 4}


async def test_access_and_office_routes(api, people):
    invited = await api("/api/access/invite", actor="admin", method="POST", body={"email": "http.member@intuitive.AI"})
    assert invited.status_code == 201 and invited.json()["temporaryPassword"]
    saved = await api("/api/access", actor="admin", method="POST", body={"signInName": "http.member@intuitive.AI", "displayName": "HTTP Member", "role": "admin"})
    assert saved.status_code == 201
    person = saved.json()
    for active in (False, True):
        assert (await api(f"/api/access/{person['id']}/active", actor="admin", method="POST", body={"active": active})).json()["active"] is active
    assert (await api(f"/api/access/{person['id']}/grants/{person['grants'][0]['id']}", actor="admin", method="DELETE")).json()["removed"]
    office = await api("/api/offices", actor="admin", method="POST", body={"name": "HTTP office"})
    assert office.status_code == 201
    office_id = office.json()["id"]
    assert (await api(f"/api/offices/{office_id}/manager", actor="admin", method="POST", body={"personId": people["manager"]["id"]})).status_code == 201
    assert (await api(f"/api/offices/{office_id}", actor="admin", method="PATCH", body={"name": "HTTP office renamed"})).json()["name"] == "HTTP office renamed"
    assert (await api("/api/people", actor="admin")).json()["people"]
    assert (await api("/api/access", actor="admin")).json()["people"]
    assert (await api("/api/directory/users?query=HTTP", actor="admin")).status_code == 503


async def test_password_http_flow_refresh_and_logout(api, db, people):
    invitation = await a.invite_person(db, people["admin"], {"email": people["manager"]["email"]})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://127.0.0.1:5173", headers={"Origin": "http://127.0.0.1:5173"}) as client:
        assert (await client.get("/api/auth/password/setup")).status_code == 401
        first = await client.post("/api/auth/password", json={"email": invitation["email"], "password": invitation["temporaryPassword"]})
        assert first.json() == {"next": "setup", "email": invitation["email"]}
        assert (await client.get("/api/auth/password/setup")).json()["email"] == invitation["email"]
        assert (await client.post("/api/auth/password/setup", json={"password": "Pantry Door 19", "confirm": "Mismatch"})).status_code == 422
        done = await client.post("/api/auth/password/setup", json={"password": "Pantry Door 19", "confirm": "Pantry Door 19"})
        assert done.json()["next"] == "app"
        csrf = done.json()["csrfToken"]
        cookies = done.headers.get_list("set-cookie")
        assert any("aim_refresh=" in cookie and "Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=7776000" in cookie for cookie in cookies)
        prior = client.cookies.get("aim_refresh")
        refreshed = await client.post("/api/auth/refresh", json={})
        assert refreshed.status_code == 200 and refreshed.json()["csrfToken"] == csrf
        assert client.cookies.get("aim_refresh") != prior
        assert (await client.post("/api/auth/logout", json={}, headers={"X-CSRF-Token": csrf})).json() == {"ok": True}
        assert (await client.get("/api/me")).status_code == 401
        assert (await client.post("/api/auth/refresh", json={})).status_code == 401
    replay = await api("/api/auth/refresh", actor="admin", method="POST", body={})
    assert replay.status_code == 200
    replay = await api("/api/auth/refresh", actor="admin", method="POST", body={})
    assert replay.status_code == 401 and all("Max-Age=0" in cookie for cookie in replay.headers.get_list("set-cookie"))


async def test_chat_json_sse_confirm_dismiss_threads_and_errors(api, db, people, monkeypatch):
    created = await api("/api/chat/threads", actor="manager", method="POST", body={})
    assert created.status_code == 201
    thread = created.json()["id"]
    streamed = await api("/api/chat", actor="manager", method="POST", body={"threadId": thread, "message": "How much coffee is left at Ahmedabad?", "stream": True})
    events = [part.split("\n", 1)[0].removeprefix("event: ") for part in streamed.text.strip().split("\n\n")]
    assert streamed.status_code == 200 and events[0] == "thread" and events[-1] == "done" and events.count("delta") > 1
    assert streamed.headers["x-accel-buffering"] == "no"
    assert len((await api(f"/api/chat/threads/{thread}", actor="manager")).json()["messages"]) == 2
    assert (await api(f"/api/chat/threads/{thread}", actor="other")).status_code == 404
    assert (await api("/api/chat/threads", actor="manager")).json()["threads"]
    proposal = await api("/api/chat", actor="manager", method="POST", body={"threadId": thread, "message": "Delete coffee at Ahmedabad"})
    proposal_id = proposal.json()["proposals"][0]["id"]
    assert (await api("/api/chat/confirm", actor="manager", method="POST", body={"threadId": "other-chat", "proposalId": proposal_id})).status_code == 404
    assert (await api("/api/chat/dismiss", actor="manager", method="POST", body={"proposalId": proposal_id})).json() == {"ok": True}
    proposal = await api("/api/chat", actor="manager", method="POST", body={"threadId": thread, "message": "Delete coffee at Ahmedabad"})
    confirmed = await api("/api/chat/confirm", actor="manager", method="POST", body={"threadId": thread, "proposalId": proposal.json()["proposals"][0]["id"]})
    assert confirmed.json()["reply"].startswith("Deleted.")
    async def broken(*args, **kwargs):
        raise RuntimeError("private upstream detail")
    monkeypatch.setattr(chat, "converse", broken)
    for stream in (False, True):
        error = await api("/api/chat", actor="manager", method="POST", body={"threadId": thread, "message": "hello", "stream": stream})
        assert "private upstream" not in error.text and "Something went wrong." in error.text and thread in error.text
        assert (error.status_code == 200 and "event: error" in error.text) if stream else error.status_code == 500
    for message in ("", "x" * 2001):
        assert (await api("/api/chat", actor="manager", method="POST", body={"message": message})).status_code == 422


async def test_parser_body_limits_and_generic_failures(api, db, monkeypatch, offices):
    for constant in ("NaN", "Infinity", "-Infinity"):
        invalid = await api("/api/settings", actor="admin", method="PATCH", content='{"weekendWeight":' + constant + '}', headers={"Content-Type": "application/json"})
        assert invalid.status_code == 400 and invalid.json() == {"error": "The request could not be read."}
    assert (await api("/api/settings", actor="admin", method="PATCH", content="{bad", headers={"Content-Type": "application/json"})).status_code == 400
    assert (await api("/api/settings", actor="admin", method="PATCH", content='"scalar"', headers={"Content-Type": "application/json"})).status_code == 400
    assert (await api("/api/settings", actor="admin", method="PATCH", body={"extra": "x" * 65536})).status_code == 413
    async def fail(*args, **kwargs):
        raise RuntimeError("private connection credentials")
    monkeypatch.setattr(db, "get", fail)
    health = await api("/api/health")
    assert health.status_code == 503 and health.json() == {"ok": False}
    error = await api("/api/me", actor="admin")
    assert error.status_code == 500 and error.json() == {"error": "Something went wrong."}


async def test_refresh_network_failure_keeps_cookies(api, monkeypatch):
    async def fail(*args, **kwargs):
        raise RuntimeError("private DB failure")
    monkeypatch.setattr(a, "rotate_refresh", fail)
    response = await api("/api/auth/refresh", actor="admin", method="POST", body={})
    assert response.status_code == 500 and not response.headers.get_list("set-cookie")


async def test_login_redirects_and_cookie_state(api):
    login = await api("/api/auth/login")
    assert login.status_code == 302 and login.headers["location"].endswith("/?auth=not_configured")
    assert (await api("/api/auth/directory")).headers["location"].endswith("/?auth=failed")
    assert (await api("/api/auth/callback?error=access_denied")).headers["location"].endswith("/?auth=cancelled")
    assert (await api("/api/auth/callback?state=wrong")).headers["location"].endswith("/?auth=expired")


async def test_no_static_secret_exposure(api):
    for path in ("/.env", "/backend/data/pantry.sqlite", "/server/data/session-secret.key", "/%2e%2e/.env", "/api/no-such-route"):
        response = await api(path)
        assert "local-test-secret-never" not in response.text
        assert "SQLite format" not in response.text
        assert "SESSION_SECRET=" not in response.text
    html = await api("/")
    assert "script-src 'self'" in html.headers["content-security-policy"]


def test_rate_limits_and_proxy_identity(monkeypatch):
    limiter = RateLimiter()
    assert limiter.check("password", "ip", 1, 1000) is None
    blocked = limiter.check("password", "ip", 1, 1000)
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "1"
    def req(headers):
        return Request({"type": "http", "headers": [(k.encode(), v.encode()) for k, v in headers.items()], "client": ("192.0.2.1", 1234)})
    assert client_ip(req({"x-forwarded-for": "spoofed"})) == "192.0.2.1"
    monkeypatch.setenv("WEBSITE_SITE_NAME", "test")
    assert client_ip(req({"client-ip": "203.0.113.1:1234"})) == "203.0.113.1"
    assert client_ip(req({"client-ip": "[2001:db8::1]:1234"})) == "2001:db8::1"
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_ORIGIN", "https://pantry.example.com")
    assert allowed_origin(req({"origin": "https://pantry.example.com"}))
    for headers in ({}, {"origin": "null"}, {"origin": "http://localhost:5173"}, {"origin": "https://pantry.example.com", "sec-fetch-site": "cross-site"}):
        assert not allowed_origin(req(headers))
