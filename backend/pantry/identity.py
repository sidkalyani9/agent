import re
from .config import UUID, production
from .compat import text


def intuitive_sign_in_name(value):
    value = text(value or "").strip()
    if not value or len(value) > 254 or re.search(r"\s", value) or value.count("@") != 1:
        return None
    local, domain = value.split("@")
    if domain.lower() != "intuitive.ai" or "#ext#" in value.lower() or not re.fullmatch(r"[A-Za-z0-9._'+-]+", local):
        return None
    return value


def identity_from_claims(claims, tenant_id, client_id):
    failed = {"ok": False, "reason": "failed"}
    domain = {"ok": False, "reason": "domain"}
    if not isinstance(claims, dict) or claims.get("tid") != tenant_id:
        return failed
    audiences = claims.get("aud") if isinstance(claims.get("aud"), list) else [claims.get("aud")]
    if client_id not in audiences or claims.get("iss") != f"https://login.microsoftonline.com/{tenant_id}/v2.0":
        return failed
    if claims.get("acct") in (1, "1") or (production() and (type(claims.get("acct")) not in (int, str) or claims.get("acct") not in (0, "0"))):
        return domain
    sign_in_name = intuitive_sign_in_name(claims.get("preferred_username"))
    if not sign_in_name:
        return domain
    if not UUID.fullmatch(text(claims.get("oid") or "")):
        return failed
    return {"ok": True, "oid": claims["oid"], "signInName": sign_in_name, "displayName": re.sub(r"[\x00-\x1f]", "", text(claims.get("name") or "")).strip()[:120]}
