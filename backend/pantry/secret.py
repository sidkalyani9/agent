import hashlib
import os
import secrets
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .passwords import b64, unb64, secret


def ensure_session_secret(data_dir):
    if len(os.getenv("SESSION_SECRET", "")) >= 32:
        return
    file = Path(data_dir) / "session-secret.key"
    if file.exists():
        stored = file.read_text().strip()
        if len(stored) >= 32:
            os.environ["SESSION_SECRET"] = stored
            return
    created = secrets.token_urlsafe(48)
    file.parent.mkdir(parents=True, exist_ok=True)
    with open(os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
        output.write(created + "\n")
    os.environ["SESSION_SECRET"] = created


def key():
    return hashlib.scrypt(secret(), salt=b"aim-session-v1", n=16384, r=8, p=1, dklen=32)


def seal(plain):
    iv = secrets.token_bytes(12)
    encrypted = AESGCM(key()).encrypt(iv, str(plain).encode(), None)
    # Node stores IV, authentication tag, ciphertext (AESGCM returns tag last).
    return b64(iv + encrypted[-16:] + encrypted[:-16])


def unseal(packed):
    value = unb64(packed or "")
    if len(value) < 29:
        raise ValueError("sealed value is unreadable")
    return AESGCM(key()).decrypt(value[:12], value[28:] + value[12:28], None).decode()
