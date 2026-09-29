"""Node-compatible scrypt hashes and app-owned HS256 sessions."""
import base64
import hashlib
import hmac
import os
import re
import secrets
import time
from .compat import dumps, loads, text, js_length

COMMON = set('password password1 password123 password1234 qwerty qwerty123 letmein welcome welcome1 admin admin123 iloveyou abc123 123456 12345678 123456789 changeme secret intuitive intuitive123 pantry pantry123 microsoft office office123'.split())
ISSUER = "intuitive-pantry"


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def unb64(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(plain):
    salt = secrets.token_bytes(16)
    hashed = hashlib.scrypt(text(plain).encode(), salt=salt, n=32768, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)
    return f"scrypt$32768$8$1${b64(salt)}${b64(hashed)}"


def verify_password(plain, stored):
    try:
        kind, n, r, p, salt, hashed = (stored or "").split("$")
        if kind != "scrypt" or (int(n), int(r), int(p)) != (32768, 8, 1):
            return False
        actual = hashlib.scrypt(text(plain).encode(), salt=unb64(salt), n=32768, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(actual, unb64(hashed))
    except (ValueError, TypeError):
        return False


DUMMY_PASSWORD_HASH = hash_password("not-a-real-invite-password")


def password_problems(plain, email):
    password = text(plain if plain is not None else "")
    problems = []
    if js_length(password) < 12:
        problems.append("Use at least 12 characters.")
    if js_length(password) > 128:
        problems.append("Use at most 128 characters.")
    if password != password.strip():
        problems.append("Do not start or end the password with a space.")
    if not all(re.search(p, password) for p in (r"[a-z]", r"[A-Z]", r"[0-9]")):
        problems.append("Use an uppercase letter, a lowercase letter, and a number.")
    local = text(email or "").split("@")[0].lower()
    folded = password.lower()
    if any(v in COMMON for v in (folded, re.sub(r"[^a-z0-9]", "", folded), re.sub(r"[^a-z]", "", folded))) or (len(local) >= 3 and local in folded):
        problems.append("Choose a password that is harder to guess.")
    return problems


def random_invite_password():
    raw = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789") for _ in range(20))
    return "-".join(raw[i:i + 5] for i in range(0, 20, 5))


def hash_token(token):
    return hashlib.sha256(text(token).encode()).hexdigest()


def secret():
    value = os.getenv("SESSION_SECRET", "")
    if len(value) < 32:
        raise ValueError("SESSION_SECRET must be at least 32 characters.")
    return value.encode()


def sign(payload, ttl=900):
    issued = int(time.time())
    header = b64(dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(dumps({"iss": ISSUER, "aud": ISSUER, "iat": issued, "exp": issued + ttl, **payload}).encode())
    signature = b64(hmac.digest(secret(), f"{header}.{body}".encode(), "sha256"))
    return f"{header}.{body}.{signature}"


def read_jwt(token, typ):
    try:
        header, body, signature = (token or "").split(".")
        metadata = loads(unb64(header))
        if not isinstance(metadata, dict) or metadata.get("alg") != "HS256" or metadata.get("typ") != "JWT":
            return None
        expected = b64(hmac.digest(secret(), f"{header}.{body}".encode(), "sha256"))
        if not hmac.compare_digest(signature.encode(), expected.encode()):
            return None
        claims = loads(unb64(body))
        if not isinstance(claims, dict) or any(claims.get(k) != v for k, v in {"iss": ISSUER, "aud": ISSUER, "typ": typ}.items()):
            return None
        current = int(time.time())
        if type(claims.get("exp")) not in (int, float) or claims["exp"] < current - 30:
            return None
        if type(claims.get("iat")) in (int, float) and claims["iat"] > current + 30:
            return None
        return claims
    except (ValueError, TypeError, UnicodeError):
        return None


def sign_access(sub, sid, csrf):
    return sign({"sub": sub, "sid": sid, "csrf": csrf, "typ": "access"})


def verify_access(token):
    claims = read_jwt(token, "access")
    return claims if claims and all(claims.get(k) for k in ("sub", "sid", "csrf")) else None


def sign_setup(sub, email, jti):
    return sign({"sub": sub, "email": email, "jti": jti, "typ": "setup"})


def verify_setup(token):
    claims = read_jwt(token, "setup")
    return claims if claims and claims.get("sub") and claims.get("jti") else None
