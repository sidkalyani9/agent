import os
from pathlib import Path
import pytest
from pantry import core, accounts, inventory


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch, tmp_path):
    for name in ("APP_ENV", "NODE_ENV", "PANTRY_SEED", "PANTRY_DB", "DATABASE_URL", "WEBSITE_SITE_NAME", "PANTRY_TRUST_PROXY", "AZURE_STORAGE_ACCOUNT_URL", "AZURE_STORAGE_CONTAINER", "TOKENROUTER_API_KEY", "OPENROUTER_API_KEY", "ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_REDIRECT_URI", "SEED_SUPERADMIN_OBJECT_ID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SESSION_SECRET", "local-test-secret-never-use-in-a-real-deployment-42")
    monkeypatch.setenv("PANTRY_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("APP_ORIGIN", "http://127.0.0.1:5173")
    token = core.set_clock(lambda: core.parse_stamp("2026-09-20T06:30:00.000Z"))
    yield
    core._clock.reset(token)


@pytest.fixture
async def db(tmp_path):
    database = await core.open_database(tmp_path / "test.sqlite", seed="fixtures")
    yield database
    await database.close()


@pytest.fixture
async def people(db):
    return {name: (await accounts.sign_in(db, email + "@intuitive.AI"))["person"] for name, email in {"admin": "avery.shah", "manager": "meera.patel", "other": "rohan.desai", "observer": "isha.rao", "reader": "kabir.mehta"}.items()}


@pytest.fixture
async def offices(db, people):
    return {row["name"]: row["id"] for row in await inventory.list_offices(db, people["admin"])}


@pytest.fixture(scope="session")
def postgres_admin_url(tmp_path_factory):
    """Use an explicit disposable service or launch a private local cluster."""
    import shutil
    import socket
    import subprocess
    configured = os.getenv("PANTRY_TEST_POSTGRES_URL")
    if configured:
        yield configured
        return
    binary = shutil.which("initdb")
    if not binary:
        candidate = Path("/Applications/Postgres.app/Contents/Versions/latest/bin/initdb")
        binary = str(candidate) if candidate.is_file() else None
    if not binary:
        pytest.fail("PostgreSQL is required for the complete suite. Set PANTRY_TEST_POSTGRES_URL to a disposable PostgreSQL service or install PostgreSQL binaries (see README.md).")
    directory = tmp_path_factory.mktemp("postgres")
    bind = socket.socket()
    bind.bind(("127.0.0.1", 0))
    port = bind.getsockname()[1]
    bind.close()
    postgres_bin = Path(binary).parent
    subprocess.run([binary, "-D", str(directory / "data"), "-A", "trust", "-U", "pantry_test", "--no-locale", "--encoding=UTF8"], check=True, capture_output=True)
    subprocess.run([str(postgres_bin / "pg_ctl"), "-D", str(directory / "data"), "-l", str(directory / "postgres.log"), "-o", f"-h 127.0.0.1 -p {port} -c unix_socket_directories=''", "-w", "start"], check=True, capture_output=True)
    try:
        yield f"postgresql://pantry_test@127.0.0.1:{port}/postgres?sslmode=disable"
    finally:
        subprocess.run([str(postgres_bin / "pg_ctl"), "-D", str(directory / "data"), "-m", "fast", "-w", "stop"], check=True, capture_output=True)


@pytest.fixture
async def postgres_database(postgres_admin_url, monkeypatch):
    """Create/drop only databases with unique test names; never use DATABASE_URL."""
    import uuid
    from urllib.parse import urlsplit, urlunsplit
    import psycopg
    from psycopg import sql
    monkeypatch.setenv("PGSSL", "disable")
    name = "pantry_test_" + uuid.uuid4().hex
    connection = await psycopg.AsyncConnection.connect(postgres_admin_url, autocommit=True)
    opened = []
    try:
        await connection.execute(sql.SQL("CREATE DATABASE {} ENCODING 'UTF8' TEMPLATE template0").format(sql.Identifier(name)))
        parsed = urlsplit(postgres_admin_url)
        target = urlunsplit(parsed._replace(path="/" + name))
        async def factory(seed="none"):
            db = await core.open_database(seed=seed, url=target)
            opened.append(db)
            return db
        yield factory
    finally:
        for database in opened:
            await database.close()
        await connection.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
        await connection.close()
