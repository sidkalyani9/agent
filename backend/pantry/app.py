import os
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException
from .config import ROOT, data_directory, validate_production_config
from .core import open_database, HttpError
from .secret import ensure_session_secret
from .http import SecurityMiddleware
from . import auth_routes, routes, chat_routes


def create_app(db=None, *, dist=None, load_env=True):
    @asynccontextmanager
    async def lifespan(app):
        if load_env:
            load_dotenv(ROOT / ".env")
        os.environ.pop("NODE_TLS_REJECT_UNAUTHORIZED", None)
        validate_production_config()
        if db is None:
            directory = data_directory()
            ensure_session_secret(directory)
            file = None if os.getenv("DATABASE_URL") else os.getenv("PANTRY_DB") or directory / "pantry.sqlite"
            app.state.db = await open_database(file)
        else:
            app.state.db = db
        try:
            yield
        finally:
            if db is None:
                await app.state.db.close()

    app = FastAPI(title="Intuitive pantry", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    if db is not None:
        app.state.db = db
    app.add_middleware(SecurityMiddleware)

    @app.exception_handler(HttpError)
    async def http_error(_request, error):
        return JSONResponse({"error": error.message}, status_code=error.status)

    @app.exception_handler(HTTPException)
    async def not_found(_request, _error):
        return JSONResponse({"error": "Not found."}, status_code=404)

    @app.get("/api/health")
    async def health(request: Request):
        try:
            await request.app.state.db.get("SELECT 1 AS ok")
            return {"ok": True}
        except Exception:
            return JSONResponse({"ok": False}, status_code=503)

    app.include_router(auth_routes.router)
    app.include_router(routes.router)
    app.include_router(chat_routes.router)
    frontend = Path(dist) if dist else ROOT / "frontend" / "dist"

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], include_in_schema=False)
    async def fallback(request: Request, path: str):
        if path == "api" or path.startswith("api/") or request.method != "GET":
            return JSONResponse({"error": "Not found."}, status_code=404)
        if not frontend.is_dir():
            return Response("Not found.", status_code=404, media_type="text/html")
        # Static files must remain inside dist; dotfiles and receipt/data paths
        # are never mounted, including after URL decoding or symlink resolution.
        candidate = (frontend / path).resolve()
        if not any(p.startswith(".") for p in Path(path).parts) and candidate.is_relative_to(frontend.resolve()) and candidate.is_file() and candidate.name != "index.html":
            return FileResponse(candidate)
        return FileResponse(frontend / "index.html", media_type="text/html")

    return app


app = create_app()
