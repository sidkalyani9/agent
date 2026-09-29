"""Microsoft authorization-code + PKCE login, validated OIDC tokens and Graph.

Only tenant-specific HTTPS Microsoft endpoints are used. ID tokens are verified
against that tenant's signing keys before any identity is admitted by the app.
"""
import asyncio
import hashlib
import hmac
import logging
import os
import re
import secrets
from urllib.parse import urlsplit, parse_qs, urlencode
import httpx
import jwt
from .core import HttpError
from .config import UUID
from .accounts import save_login_attempt, take_login_attempt, graph_refresh_for, store_graph_refresh
from .identity import identity_from_claims, intuitive_sign_in_name
from .secret import seal, unseal
from .passwords import b64
from .compat import text

LOGIN_SCOPE = "openid profile email offline_access"
DIRECTORY_SCOPE = LOGIN_SCOPE + " https://graph.microsoft.com/User.ReadBasic.All"
logger = logging.getLogger(__name__)


def entra_settings():
    tenant, client, secret, redirect = [os.getenv(k, "").strip() for k in ("ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_REDIRECT_URI")]
    origin = os.getenv("APP_ORIGIN", "http://127.0.0.1:5173").rstrip("/")
    if not UUID.fullmatch(tenant) or not UUID.fullmatch(client) or len(secret) < 10:
        return None
    try:
        target, base = urlsplit(redirect), urlsplit(origin)
        if not target.netloc or not base.netloc or (target.scheme, target.netloc) != (base.scheme, base.netloc) or target.path != "/api/auth/callback" or target.username or target.password or target.fragment:
            return None
    except ValueError:
        return None
    return {"tenantId": tenant, "clientId": client, "clientSecret": secret, "redirectUri": f"{target.scheme}://{target.netloc}{target.path}", "origin": origin}


def microsoft_endpoint(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "login.microsoftonline.com" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Invalid Microsoft identity endpoint.")
    return url


async def configuration(client, settings):
    issuer = f"https://login.microsoftonline.com/{settings['tenantId']}/v2.0"
    response = await client.get(issuer + "/.well-known/openid-configuration")
    response.raise_for_status()
    config = response.json()
    if config.get("issuer") != issuer:
        raise ValueError("Invalid Microsoft issuer.")
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        microsoft_endpoint(config[key])
    return config


async def begin_sign_in(db, purpose):
    settings = entra_settings()
    if not settings:
        return {"error": "not_configured"}
    async with httpx.AsyncClient(timeout=15) as client:
        config = await configuration(client, settings)
    verifier, state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    challenge = b64(hashlib.sha256(verifier.encode()).digest())
    await save_login_attempt(db, state=state, verifier=verifier, nonce=nonce, purpose=purpose)
    params = {"redirect_uri": settings["redirectUri"], "client_id": settings["clientId"], "scope": DIRECTORY_SCOPE if purpose == "directory" else LOGIN_SCOPE,
              "code_challenge": challenge, "code_challenge_method": "S256", "state": state, "nonce": nonce, "response_type": "code", "prompt": "select_account", "domain_hint": "intuitive.ai"}
    return {"url": config["authorization_endpoint"] + "?" + urlencode(params), "state": state}


async def verify_id_token(client, token, config, settings, nonce, access_token=None):
    header = jwt.get_unverified_header(token)
    # Never choose the algorithm from an untrusted token without an allowlist.
    if header.get("alg") != "RS256" or not header.get("kid"):
        raise ValueError("Invalid Microsoft token algorithm.")
    response = await client.get(config["jwks_uri"])
    response.raise_for_status()
    keys = response.json().get("keys", [])
    candidates = [k for k in keys if k.get("kid") == header["kid"] and k.get("kty") == "RSA" and k.get("use", "sig") == "sig" and k.get("alg", "RS256") == "RS256"]
    if len(candidates) != 1:
        raise ValueError("Microsoft signing key not found.")
    claims = jwt.decode(token, jwt.PyJWK.from_dict(candidates[0]).key, algorithms=["RS256"], issuer=config["issuer"], audience=settings["clientId"], leeway=30, options={"require": ["exp", "iat", "iss", "aud", "sub", "nonce"]})
    if not isinstance(claims.get("nonce"), str) or not hmac.compare_digest(claims["nonce"].encode(), nonce.encode()):
        raise ValueError("Microsoft nonce mismatch.")
    if claims.get("azp") and claims["azp"] != settings["clientId"]:
        raise ValueError("Microsoft authorized party mismatch.")
    if isinstance(claims["aud"], list) and len(claims["aud"]) > 1 and claims.get("azp") != settings["clientId"]:
        raise ValueError("Microsoft authorized party missing.")
    if access_token and claims.get("at_hash"):
        expected = b64(hashlib.sha256(access_token.encode()).digest()[:16])
        if not hmac.compare_digest(expected, claims["at_hash"]):
            raise ValueError("Microsoft access-token hash mismatch.")
    return claims


async def finish_sign_in(db, current_url):
    settings = entra_settings()
    if not settings:
        return {"error": "not_configured"}
    query = parse_qs(urlsplit(str(current_url)).query)
    states = query.get("state", [])
    if len(states) != 1 or not states[0]:
        return {"error": "expired"}
    attempt = await take_login_attempt(db, states[0])
    if not attempt:
        return {"error": "expired"}
    try:
        codes = query.get("code", [])
        if len(codes) != 1 or not codes[0]:
            raise ValueError("Missing authorization code.")
        async with httpx.AsyncClient(timeout=15) as client:
            config = await configuration(client, settings)
            response = await client.post(config["token_endpoint"], data={"grant_type": "authorization_code", "client_id": settings["clientId"], "client_secret": settings["clientSecret"], "code": codes[0], "redirect_uri": settings["redirectUri"], "code_verifier": attempt["code_verifier"]})
            response.raise_for_status()
            tokens = response.json()
            claims = await verify_id_token(client, tokens["id_token"], config, settings, attempt["nonce"], tokens.get("access_token"))
    except Exception:
        logger.warning("Microsoft sign-in failed.")
        return {"error": "failed"}
    identity = identity_from_claims(claims, settings["tenantId"], settings["clientId"])
    if not identity["ok"]:
        return {"error": identity.get("reason") or "failed"}
    return {"purpose": attempt["purpose"], "identity": identity, "refreshToken": tokens.get("refresh_token") or ""}


CONSENT = "Directory search needs a one-time Microsoft admin consent for work-account lookup. You can still add an @intuitive.AI sign-in name."


async def search_directory(db, refresh_id, query):
    settings = entra_settings()
    if not settings:
        raise HttpError(503, "Microsoft sign-in is not configured yet.", "not_configured")
    sealed = await graph_refresh_for(db, refresh_id)
    if not sealed:
        raise HttpError(503, "Connect directory search once. It needs Microsoft admin consent. You can still add an @intuitive.AI sign-in name.", "directory_off")
    try:
        refresh = unseal(sealed)
    except Exception:
        raise HttpError(503, "Connect directory search again.", "directory_off") from None
    async with httpx.AsyncClient(timeout=15) as client:
        config = await configuration(client, settings)
        try:
            response = await client.post(config["token_endpoint"], data={"grant_type": "refresh_token", "client_id": settings["clientId"], "client_secret": settings["clientSecret"], "refresh_token": refresh, "scope": "https://graph.microsoft.com/User.ReadBasic.All offline_access"})
            response.raise_for_status()
            tokens = response.json()
        except Exception:
            logger.warning("Directory token refresh failed.")
            raise HttpError(503, CONSENT, "directory_consent") from None
        if tokens.get("refresh_token"):
            await store_graph_refresh(db, refresh_id, seal(tokens["refresh_token"]))
        query = re.sub(r'["\\]', "", text(query or "")).strip()[:60]
        if len(query) < 2:
            raise HttpError(422, "Type at least two letters to search.")
        response = await client.get("https://graph.microsoft.com/v1.0/users", params={"$search": f'"displayName:{query}" OR "mail:{query}" OR "userPrincipalName:{query}"', "$select": "id,displayName,userPrincipalName,mail,userType", "$top": "15"}, headers={"Authorization": f"Bearer {tokens['access_token']}", "ConsistencyLevel": "eventual"})
    if response.status_code in (401, 403):
        raise HttpError(503, CONSENT, "directory_consent")
    if not response.is_success:
        raise HttpError(502, "The company directory did not answer. You can still add an @intuitive.AI sign-in name.")
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    people = []
    for user in payload.get("value", []):
        if user.get("userType") and user["userType"] != "Member":
            continue
        email = intuitive_sign_in_name(user.get("userPrincipalName")) or intuitive_sign_in_name(user.get("mail"))
        if not email or not UUID.fullmatch(text(user.get("id") or "")):
            continue
        people.append({"directoryObjectId": text(user["id"]), "displayName": re.sub(r"[\x00-\x1f]", "", text(user.get("displayName") or email)).strip()[:120], "signInName": email})
    return people
