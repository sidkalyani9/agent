"""ASGI security envelope preserving the browser's existing HTTP contract."""
import hmac
import ipaddress
import logging
import math
import os
import re
import time
from collections import OrderedDict
from urllib.parse import quote, unquote
from starlette.requests import Request
from starlette.responses import JSONResponse
from .config import production
from .compat import loads
from .core import HttpError
from .accounts import person_from_access_token

logger = logging.getLogger(__name__)
CSP = "; ".join(["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"])
PUBLIC = {("GET", "/api/health"), ("GET", "/api/auth/login"), ("GET", "/api/auth/directory"), ("GET", "/api/auth/callback"), ("POST", "/api/auth/password"), ("GET", "/api/auth/password/setup"), ("POST", "/api/auth/password/setup"), ("POST", "/api/auth/refresh")}
AUTH_LIMITS = {"/api/auth/login": ("login", 20), "/api/auth/directory": ("login", 20), "/api/auth/callback": ("callback", 30), "/api/auth/password": ("password", 60), "/api/auth/password/setup": ("setup", 10), "/api/auth/refresh": ("refresh", 60)}


def cookies_are_secure():
    return os.getenv("APP_ORIGIN", "").startswith("https://")


def read_cookies(request):
    cookies = {}
    for part in request.headers.get("cookie", "").split(";"):
        if "=" in part and part.index("=") >= 1:
            key, value = part.split("=", 1)
            cookies[key.strip()] = unquote(value.strip())
    return cookies


def write_cookie(response, name, value, *, max_age, path="/"):
    cookie = f"{name}={quote(str(value), safe='~()*!.\x27-')}; Path={path}; HttpOnly; SameSite=Lax; Max-Age={max_age}"
    if cookies_are_secure():
        cookie += "; Secure"
    response.headers.append("set-cookie", cookie)


def clear_cookie(response, name, path="/"):
    write_cookie(response, name, "", max_age=0, path=path)


def set_auth_cookies(response, issued):
    write_cookie(response, "aim_access", issued["accessToken"], max_age=900)
    write_cookie(response, "aim_refresh", issued["refreshToken"], max_age=issued["refreshMaxAge"], path="/api/auth")
    clear_cookie(response, "aim_setup", "/api/auth")
    clear_cookie(response, "aim_session")


def clear_auth_cookies(response):
    for name, path in [("aim_access", "/"), ("aim_refresh", "/api/auth"), ("aim_setup", "/api/auth"), ("aim_session", "/")]:
        clear_cookie(response, name, path)


def allowed_origin(request):
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") == "cross-site":
        return False
    if not origin:
        return not production()
    allowed = set() if production() else {"http://127.0.0.1:5173", "http://localhost:5173"}
    configured = os.getenv("APP_ORIGIN", "").rstrip("/")
    if configured:
        allowed.add(configured)
    return origin.rstrip("/") in allowed


def csrf_ok(header, expected):
    return bool(header and expected and hmac.compare_digest(str(header).encode(), str(expected).encode()))


def client_ip(request):
    if os.getenv("WEBSITE_SITE_NAME"):
        raw = request.headers.get("client-ip", "").strip()
        if re.fullmatch(r"\[[^\]]+\]:\d+", raw):
            candidate = raw[1:raw.index("]")]
        elif re.fullmatch(r"\d+\.\d+\.\d+\.\d+:\d+", raw):
            candidate = raw.split(":")[0]
        else:
            candidate = raw
        try:
            ipaddress.ip_address(candidate)
            return candidate
        except ValueError:
            pass
    address = request.client.host if request.client else "unknown"
    # Match the old opt-in loopback proxy trust; ordinary callers cannot make
    # their own X-Forwarded-For identity authoritative.
    if os.getenv("PANTRY_TRUST_PROXY") == "1":
        try:
            if ipaddress.ip_address(address).is_loopback:
                chain = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
                for candidate in reversed(chain):
                    address = candidate
                    if not ipaddress.ip_address(candidate).is_loopback:
                        break
        except ValueError:
            pass
    return address


class RateLimiter:
    def __init__(self):
        self.buckets = OrderedDict()

    def check(self, name, key, limit, window_ms):
        now = time.monotonic() * 1000
        bucket_key = f"{name}:{key}"
        previous = self.buckets.get(bucket_key, ([], 0))[0]
        fresh = [at for at in previous if now - at < window_ms]
        if len(fresh) >= limit:
            return JSONResponse({"error": "Too many requests. Wait a minute and try again."}, status_code=429, headers={"Retry-After": str(math.ceil(window_ms / 1000))})
        fresh.append(now)
        self.buckets[bucket_key] = (fresh, now + window_ms)
        if len(self.buckets) > 5000:
            for key, (_, expires) in list(self.buckets.items()):
                if expires <= now:
                    del self.buckets[key]
            if len(self.buckets) > 10000:
                self.buckets.popitem(last=False)
        return None


class SecurityMiddleware:
    def __init__(self, app):
        self.app = app
        self.limiter = RateLimiter()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        # Express accepts a trailing slash. Disable FastAPI's redirect (a 307
        # would change POST semantics observed by existing callers).
        scope["path"] = scope["path"].rstrip("/") or "/"
        request = Request(scope, receive)
        path, method = scope["path"], scope["method"]
        if method == "HEAD":
            scope["method"] = "GET"
        headers = {"content-security-policy": CSP, "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "permissions-policy": "camera=(), microphone=(), geolocation=()", "cross-origin-resource-policy": "same-origin", "x-dns-prefetch-control": "off", "cache-control": "no-store"}
        if cookies_are_secure():
            headers["strict-transport-security"] = "max-age=31536000"
        started = False
        async def secured_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                existing = dict(message.get("headers", []))
                for key, value in headers.items():
                    existing.setdefault(key.encode(), value.encode())
                # Preserve multiple Set-Cookie headers.
                cookies = [h for h in message.get("headers", []) if h[0] == b"set-cookie"]
                existing.pop(b"set-cookie", None)
                message["headers"] = list(existing.items()) + cookies
            elif method == "HEAD" and message["type"] == "http.response.body":
                message["body"] = b""
            await send(message)
        async def reply(response):
            await response(scope, receive, secured_send)
        try:
            ip = client_ip(request)
            limited = self.limiter.check("api", ip, 300, 60000)
            if limited:
                return await reply(limited)
            scope.setdefault("state", {})["body"] = {}
            if request.headers.get("content-type", "").split(";")[0].strip().lower() == "application/json":
                upload = (method == "POST" and re.fullmatch(r"/api/offices/[^/]+/purchases", path)) or (method == "PUT" and re.fullmatch(r"/api/purchases/[^/]+/receipt", path))
                limit = 14 * 1024 * 1024 if upload else 64 * 1024
                if request.headers.get("content-encoding", "identity").lower() != "identity":
                    raise ValueError("Unsupported body encoding")
                if int(request.headers.get("content-length", "0")) > limit:
                    raise HttpError(413, "That upload is too large.")
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > limit:
                        raise HttpError(413, "That upload is too large.")
                    chunks.append(chunk)
                data = b"".join(chunks)
                try:
                    body = loads(data) if data else {}
                    if not isinstance(body, (dict, list)):
                        raise ValueError()
                except (ValueError, UnicodeError):
                    raise HttpError(400, "The request could not be read.") from None
                scope["state"]["body"] = body if isinstance(body, dict) else {}
            public = (scope["method"], path) in PUBLIC
            if public:
                if path in AUTH_LIMITS and not (method in ("GET", "HEAD") and path == "/api/auth/password/setup"):
                    name, limit = AUTH_LIMITS[path]
                    limited = self.limiter.check(name, ip, limit, 600000)
                    if limited:
                        return await reply(limited)
                if method == "POST" and not allowed_origin(request):
                    raise HttpError(403, "This action was blocked.")
            else:
                session = await person_from_access_token(scope["app"].state.db, read_cookies(request).get("aim_access", ""))
                scope["state"]["session"] = session
                if method not in ("GET", "HEAD", "OPTIONS") and path.startswith("/api/"):
                    if not allowed_origin(request):
                        raise HttpError(403, "This action was blocked.")
                    if not session:
                        raise HttpError(401, "Sign in with an @intuitive.AI account.")
                    if not csrf_ok(request.headers.get("x-csrf-token"), session["csrf"]):
                        return await reply(JSONResponse({"error": "Sign in again, then retry that action.", "code": "csrf"}, status_code=403))
                if path == "/api/chat" and method == "POST" and session:
                    limited = self.limiter.check("chat", session["person"]["id"], 20, 60000)
                    if limited:
                        return await reply(limited)
            await self.app(scope, receive, secured_send)
        except Exception as error:
            if started:
                raise
            status, message = (error.status, error.message) if isinstance(error, HttpError) else (500, "Something went wrong.")
            if status == 500:
                logger.error("Request failed (%s).", type(error).__name__)
            await reply(JSONResponse({"error": message}, status_code=status))
