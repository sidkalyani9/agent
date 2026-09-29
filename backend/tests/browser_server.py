"""Disposable real FastAPI server for browser/API end-to-end tests only."""
import asyncio
import json
import os
import socket
import tempfile
from pathlib import Path
import uvicorn
from pantry import core as c, accounts as a, inventory as i
from pantry.app import create_app


async def main():
    with tempfile.TemporaryDirectory(prefix="pantry-browser-") as folder:
        for key in ("APP_ENV", "NODE_ENV", "PANTRY_SEED", "PANTRY_DB", "DATABASE_URL", "WEBSITE_SITE_NAME", "PANTRY_TRUST_PROXY", "AZURE_STORAGE_ACCOUNT_URL", "TOKENROUTER_API_KEY", "OPENROUTER_API_KEY", "ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "SEED_SUPERADMIN_OBJECT_ID"):
            os.environ.pop(key, None)
        os.environ["SESSION_SECRET"] = "local-test-secret-never-use-in-a-real-deployment-42"
        os.environ["PANTRY_DATA_DIR"] = folder
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        os.environ["APP_ORIGIN"] = base
        db = await c.open_database(Path(folder) / "test.sqlite", seed="fixtures")
        try:
            people = {key: (await a.sign_in(db, mailbox + "@intuitive.AI"))["person"] for key, mailbox in {"admin": "avery.shah", "manager": "meera.patel", "reader": "kabir.mehta", "observer": "isha.rao", "otherManager": "rohan.desai"}.items()}
            password = "Local test login 42"
            for person in people.values():
                invite = await a.invite_person(db, people["admin"], {"email": person["email"]})
                setup = await a.login_with_password(db, invite["email"], invite["temporaryPassword"])
                await a.complete_password_setup(db, setup["setupToken"], password, password)
            sessions = {key: await a.begin_browser_session(db, person["id"]) for key, person in people.items()}
            metadata = {"base": base, "password": password, **people, "sessions": sessions, "offices": await i.list_offices(db, people["admin"])}
            # stdout is consumed privately by the test harness. No real data or
            # credentials are ever read by this entry point.
            print("PANTRY_TEST_APP " + json.dumps(metadata), flush=True)
            app = create_app(db, load_env=False)
            server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="warning", proxy_headers=False, server_header=False))
            await server.serve(sockets=[sock])
        finally:
            sock.close()
            await db.close()


if __name__ == "__main__":
    asyncio.run(main())
