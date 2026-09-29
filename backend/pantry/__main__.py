"""Start one API process. Use --reload only for local development."""
import argparse
import os
import socket
from dotenv import load_dotenv
import uvicorn
from .config import ROOT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    os.environ.pop("NODE_TLS_REJECT_UNAUTHORIZED", None)
    host = "0.0.0.0" if os.getenv("WEBSITE_SITE_NAME") else os.getenv("PANTRY_HOST") or "127.0.0.1"
    port = int(os.getenv("PORT") or 8787)
    # Explicit socket also supports port 0 for isolated end-to-end tests.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    print(f"Pantry API on http://{host}:{sock.getsockname()[1]}", flush=True)
    uvicorn.run("pantry.app:app", fd=sock.fileno(), reload=args.reload, reload_dirs=[str(ROOT / "backend" / "pantry")] if args.reload else None,
                workers=1, proxy_headers=False, server_header=False, access_log=False, timeout_keep_alive=5, timeout_graceful_shutdown=10)


if __name__ == "__main__":
    main()
