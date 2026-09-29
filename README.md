# Intuitive pantry

Phase 1 pantry expense management for invited Intuitive employees. React displays stock and spend calculated by the Python/FastAPI backend. Microsoft and local password sign-in share the same app-owned access list.

- [Migration checklist, compatibility and test evidence](documents/PYTHON_MIGRATION.md)
- [Production review and remaining release gates](documents/PRODUCTION_READINESS.md)
- [Azure deployment, migration and recovery](documents/AZURE_DEPLOYMENT.md)
- [Original scope / BRD](documents/Accounts_and_Inventory_Management_Agent_Scope_and_BRD.pdf)
- [Contributor rules](AGENTS.md)

## Layout

```text
frontend/             React/Vite source, public assets and browser tests
backend/pantry/       FastAPI application, services, calculations and SQL schema
backend/tests/        Python contracts, HTTP, database and integration tests
backend/requirements* Pinned Python runtime and development dependencies
scripts/              Local launchers, release packaging and baseline capture
.github/workflows/    Python + frontend checks and release artifact
```

The root npm workspace only coordinates frontend tooling and Python launchers. Node is not needed to run a built production release.

## Run locally

Use Python 3.12 (`.python-version`) and Node.js 24 LTS (`.nvmrc`). From this repository root:

```sh
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
npm ci
npm run dev
```

On Windows, use `py -3.12 -m venv backend/.venv` and `backend/.venv/Scripts/python.exe` instead. The npm launchers detect the virtual environment on either platform; `PANTRY_PYTHON` can override its interpreter.

Copy `.env.example` to a private `.env` and configure Microsoft sign-in if needed. Open `http://127.0.0.1:5173`; Vite forwards `/api` to FastAPI on port 8787. Do not use production credentials for tests or enable fixture seeding in your local `.env`.

New checkouts store local SQLite/receipts/signing secret in `backend/data/`. If an existing `server/data/` directory is present, it remains the default so existing records, receipts and sessions are preserved. `PANTRY_DATA_DIR` explicitly overrides that location. The old data and MVP backup are never moved or deleted by this migration. A new real database starts with only the configured Super Admin, no offices and no default password; first access uses that person's Microsoft identity.

For the built frontend:

```sh
npm run build
npm start
```

FastAPI serves `frontend/dist` and `/api`. Set `APP_ORIGIN` and the Microsoft callback to the actual browser origin. The direct Python equivalent, after activating the virtual environment, is `PYTHONPATH=backend python -m pantry` (PowerShell: set `$env:PYTHONPATH="backend"` first). Production uses `bash startup.sh`, which defaults to App Service's port 8000.

## Verify changes

The complete suite requires PostgreSQL. Install local PostgreSQL binaries (`initdb`, `pg_ctl`; Postgres.app is also detected on macOS), or set `PANTRY_TEST_POSTGRES_URL` to a **disposable** PostgreSQL service with permission to create/drop databases. Each test creates a unique database. Tests never fall back to `DATABASE_URL` and never silently skip PostgreSQL coverage. CI supplies its own PostgreSQL 16 service.

```sh
npm run build
npm test
npx playwright install chromium
npm run test:browser
backend/.venv/bin/python -m pip check
backend/.venv/bin/python -m pip_audit -r backend/requirements.txt --no-deps --disable-pip
npm audit --audit-level=high
```

Browser tests start real FastAPI on a free loopback port with disposable data. An existing development server can keep running. `PANTRY_BROWSER_CHANNEL=chrome npm run test:browser` uses installed Chrome. Tests cover the original Node contract corpus, HTTP routes, real PostgreSQL, signed Microsoft tokens/mock Graph and Blob, release startup/restart, and desktop/mobile workflows. No live pantry or cloud credentials are used. Azure networking, TLS and managed identity still need staging validation.

For backend-only work, activate the environment and run `python -m pytest -c backend/pyproject.toml backend/tests`. Build the frontend first because the full suite also verifies the packaged website. Python direct dependencies are declared in `backend/pyproject.toml`; the requirements files pin their full dependency closure. When updating dependencies, update both, install into a clean Python 3.12 environment, run `pip check`, the full suite and audits. Frontend versions are locked in the root workspace `package-lock.json`.

## Production

One Linux Azure App Service runs Python 3.12/Uvicorn and the built React frontend. PostgreSQL stores application data and sessions; a private Azure Blob container stores receipts; Key Vault supplies secrets. Start with one process/instance. `APP_ENV=production` enables fail-closed production checks; existing `NODE_ENV=production` settings remain supported. Keep `SESSION_SECRET` stable through cutover.

After verification, `python scripts/package_release.py` stages a clean `release/` artifact with runtime source, pinned requirements, startup script and built frontend. It refuses to overwrite a nonempty directory. GitHub checks build and upload this artifact; they do not deploy. Follow the [Azure guide](documents/AZURE_DEPLOYMENT.md) for Python runtime configuration and Oryx dependency installation.

Sessions retain their 15-minute access cookies and rotating refresh cookies with 90-day inactivity / 180-day absolute limits. Local password login has no MFA by the owner's explicit choice; Microsoft MFA does not protect that alternative route.
