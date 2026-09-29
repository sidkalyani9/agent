import os
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
SESSION_IDLE_SECONDS = 90 * 86400
SESSION_ABSOLUTE_SECONDS = 180 * 86400
INVITE_SECONDS = 7 * 86400
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def production():
    # Either setting enables the guardrails; a conflicting/new setting must not
    # weaken an existing NODE_ENV=production deployment during cutover.
    return os.getenv("APP_ENV") == "production" or os.getenv("NODE_ENV") == "production"


def data_directory():
    if os.getenv("PANTRY_DATA_DIR"):
        return Path(os.environ["PANTRY_DATA_DIR"]).resolve()
    legacy = ROOT / "server" / "data"
    modern = ROOT / "backend" / "data"
    # Source-preserving compatibility: never silently initialize an empty pantry
    # beside the old database, signing secret, receipts or MVP backup.
    return legacy if legacy.exists() else modern


def validate_production_config():
    if not production():
        return
    for name in ["SESSION_SECRET", "ENTRA_CLIENT_SECRET", "DATABASE_URL", "TOKENROUTER_API_KEY", "OPENROUTER_API_KEY"]:
        if re.match(r"^@Microsoft\.KeyVault\(", os.getenv(name, "").strip(), re.I):
            raise ValueError(f"Production {name} contains an unresolved Key Vault reference.")
    origin = urlsplit(os.getenv("APP_ORIGIN", ""))
    if origin.scheme != "https" or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ("", "/"):
        raise ValueError("Production APP_ORIGIN must be an HTTPS origin without a path.")
    if len(os.getenv("SESSION_SECRET", "")) < 48:
        raise ValueError("Production requires a random SESSION_SECRET of at least 48 characters.")
    if os.getenv("PANTRY_SEED") == "fixtures":
        raise ValueError("Fixture data is forbidden in production.")
    if not os.getenv("DATABASE_URL"):
        raise ValueError("Production requires DATABASE_URL for PostgreSQL.")
    if not re.match(r"^postgres(ql)?://", os.environ["DATABASE_URL"]):
        raise ValueError("DATABASE_URL must point to PostgreSQL.")
    if not re.fullmatch(r"https://[a-z0-9]+\.blob\.core\.windows\.net/?", os.getenv("AZURE_STORAGE_ACCOUNT_URL", "")):
        raise ValueError("Production requires an Azure Blob Storage account URL.")
    for name in ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "SEED_SUPERADMIN_OBJECT_ID"]:
        if not UUID.fullmatch(os.getenv(name, "")):
            raise ValueError(f"Production requires {name}.")
    if len(os.getenv("ENTRA_CLIENT_SECRET", "")) < 10 or os.getenv("ENTRA_REDIRECT_URI") != f"https://{origin.netloc}/api/auth/callback":
        raise ValueError("Production requires valid Microsoft credentials and the exact HTTPS callback URL.")
