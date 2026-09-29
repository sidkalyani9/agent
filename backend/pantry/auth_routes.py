import os
from urllib.parse import parse_qs
from fastapi import APIRouter, Request
from starlette.responses import JSONResponse, RedirectResponse
from . import accounts as a, entra
from .core import HttpError
from .secret import seal
from .http import read_cookies, write_cookie, clear_cookie, set_auth_cookies, clear_auth_cookies, csrf_ok

router = APIRouter()
AUTH_CODES = {"not_configured", "not_on_list", "inactive", "domain", "cancelled", "expired", "failed", "directory_ready"}


def app_url(path):
    return os.getenv("APP_ORIGIN", "http://127.0.0.1:5173").rstrip("/") + path


def send_auth(code):
    response = RedirectResponse(app_url("/?auth=" + (code if code in AUTH_CODES else "failed")), status_code=302)
    clear_cookie(response, "aim_login", "/api/auth/callback")
    return response


@router.get("/api/auth/login")
async def login(request: Request):
    started = await entra.begin_sign_in(request.app.state.db, "login")
    if started.get("error"):
        return send_auth(started["error"])
    response = RedirectResponse(started["url"], status_code=302)
    write_cookie(response, "aim_login", started["state"], max_age=600, path="/api/auth/callback")
    return response


@router.get("/api/auth/directory")
async def directory(request: Request):
    db = request.app.state.db
    session = await a.person_from_access_token(db, read_cookies(request).get("aim_access", ""))
    if not session or not session["person"]["superAdmin"]:
        return send_auth("failed")
    started = await entra.begin_sign_in(db, "directory")
    if started.get("error"):
        return send_auth(started["error"])
    response = RedirectResponse(started["url"], status_code=302)
    write_cookie(response, "aim_login", started["state"], max_age=600, path="/api/auth/callback")
    return response


@router.get("/api/auth/callback")
async def callback(request: Request):
    db = request.app.state.db
    query = parse_qs(request.url.query)
    if query.get("error"):
        return send_auth("cancelled" if query["error"][0] == "access_denied" else "failed")
    states = query.get("state", [])
    if len(states) != 1 or not csrf_ok(read_cookies(request).get("aim_login", ""), states[0]):
        return send_auth("expired")
    finished = await entra.finish_sign_in(db, request.url)
    if finished.get("error"):
        return send_auth(finished["error"])
    if finished["purpose"] == "directory":
        session = await a.person_from_access_token(db, read_cookies(request).get("aim_access", ""))
        if not session or not session["person"]["superAdmin"] or session["person"]["email"].lower() != finished["identity"]["signInName"].lower():
            return send_auth("failed")
        if finished["refreshToken"]:
            await a.store_graph_refresh(db, session["refreshId"], seal(finished["refreshToken"]))
        return send_auth("directory_ready")
    try:
        person = await a.accept_microsoft_login(db, finished["identity"])
        response = RedirectResponse(app_url("/"), status_code=302)
        set_auth_cookies(response, await a.begin_browser_session(db, person["id"]))
        clear_cookie(response, "aim_login", "/api/auth/callback")
        return response
    except Exception as error:
        return send_auth(error.code if isinstance(error, HttpError) else "failed")


@router.post("/api/auth/password")
async def password(request: Request):
    body = request.state.body
    result = await a.login_with_password(request.app.state.db, body.get("email"), body.get("password"))
    if result["next"] == "setup":
        response = JSONResponse({"next": "setup", "email": result["email"]})
        write_cookie(response, "aim_setup", result["setupToken"], max_age=900, path="/api/auth")
        clear_cookie(response, "aim_access")
        clear_cookie(response, "aim_refresh", "/api/auth")
        return response
    response = JSONResponse({"next": "app", "csrfToken": result["csrf"], "person": result["person"]})
    set_auth_cookies(response, result)
    return response


@router.get("/api/auth/password/setup")
async def setup_context(request: Request):
    token = read_cookies(request).get("aim_setup", "")
    context = await a.setup_context(request.app.state.db, token) if token else None
    if not context:
        raise HttpError(401, "That setup step expired. Sign in with the invite password again." if token else "Sign in with the invite password first.")
    return context


@router.post("/api/auth/password/setup")
async def setup(request: Request):
    body = request.state.body
    result = await a.complete_password_setup(request.app.state.db, read_cookies(request).get("aim_setup", ""), body.get("password"), body.get("confirm"))
    response = JSONResponse({"next": "app", "csrfToken": result["csrf"], "person": result["person"]})
    set_auth_cookies(response, result)
    return response


@router.post("/api/auth/refresh")
async def refresh(request: Request):
    try:
        issued = await a.rotate_refresh(request.app.state.db, read_cookies(request).get("aim_refresh", ""))
    except HttpError as error:
        if error.status != 401:
            raise
        response = JSONResponse({"error": error.message}, status_code=401)
        clear_auth_cookies(response)
        return response
    response = JSONResponse({"csrfToken": issued["csrf"], "person": issued["person"]})
    set_auth_cookies(response, issued)
    return response
