# FastAPI migration task list

This document tracks the migration from Express to Python/FastAPI. Existing HTTP contracts, data, credentials, authorization and frontend behavior are the compatibility baseline. Live databases and production services are not used by tests.

## Tasks

- [x] Read repository rules and inventory the application and workflow.
- [x] Run the existing Node 24 suite and browser baseline; record results.
- [x] Capture calculation, service, credential and chat compatibility cases (85 service cases, 120 calculation scenarios, 44 HTTP method/path contracts).
- [x] Implement Python configuration, SQLite/PostgreSQL transactions and schema compatibility.
- [x] Port calculations, service authorization and pantry operations.
- [x] Port password hashing, JWTs, refresh rotation, invitations and Microsoft sign-in.
- [x] Port receipts, chat tools, confirmations, model integration and SSE.
- [x] Implement the complete FastAPI HTTP surface and security middleware.
- [x] Separate frontend/ and backend/ source, dependencies, builds and development commands.
- [x] Port migration tooling and update GitHub checks and deployment documentation.
- [x] Run Python unit/integration tests and Node-to-Python compatibility checks.
- [x] Run PostgreSQL integration tests against an isolated database.
- [x] Run complete browser flows against FastAPI at desktop and mobile widths.
- [x] Review the final diff, record verification and external release gates.

## Compatibility and cutover

- Keep SQL table/column names, password hash format, encrypted-token format and session signing compatible.
- Preserve API JSON keys/status codes, cookie names/paths, CSRF behavior, CSV and receipt downloads, and SSE events.
- Preserve local pantry data and the frozen MVP backup. Any local path migration must be explicit and source-preserving.
- Test with temporary SQLite files and isolated PostgreSQL only. Do not perform a live database migration or deployment.
- Real Microsoft tenant login and Azure networking/managed identity require staging credentials; mocked integration coverage does not count as staging verification.

## Verification log

- Initial baseline attempt: shell Node 23.2.0 lacks the enabled `node:sqlite` required by the project's Node 24 target. No application change made in response; obtain the required runtime for baseline tests.

- Node 24.21.0 baseline: all 42 tests pass, including PGlite PostgreSQL and local HTTP. Vite production build passes. The initial environment blocked local socket binding; verification completed after socket access became available.

- Original browser baseline passes with installed Chrome on isolated port 5187: login, edit, purchase/receipt, screens, theme, two-tab refresh, persistent cookies, mobile and logout.
- First Python golden comparison: all 120 calculation scenarios and Node credential compatibility pass. It caught `Sep` versus Node’s `Sept` in CSV date labels; Python formatting corrected.

- Complete Python suite: 207 passing (no skips); 89% line coverage in the in-process run. Packaged entry-point startup/restart is tested in subprocesses, outside that coverage measurement.
- Real PostgreSQL 15.3: all contract, concurrent refresh, receipt rollback and migration tests pass. Fixed URI space encoding (`%20`, not `+`) and PostgreSQL statement batches based on this run. CI uses PostgreSQL 16.
- Python runtime and frontend dependency audits: no known vulnerabilities. `pip check` passes.

- Final full suite: **209 Python tests pass, no skips**, after the Node session cutover and JSON/Unicode compatibility checks were added. `npm run build` passes; moved frontend source/assets match all 28 original files byte-for-byte.
- Expanded real Chrome browser suite passes against FastAPI at 1440px and 390px: login, office creation/manager assignment, All offices, product edit/create, purchase/receipt, count, settings, charts/activity, CSV, factual streaming chat, proposal dismissal/confirmation/history, invitation/password setup, live grant removal, disabling/re-enabling, read-only Accounts/Admin, theme, two-tab refresh, persistent cookies and logout. Desktop/mobile screenshots reviewed.
- A clean Python environment installed from runtime requirements alone passes `pip check`, packaged startup/restart/static delivery, and the complete browser suite. Production startup does not need Node or test dependencies.

## Coverage map

| Area | Evidence |
| --- | --- |
| Stock, dates, burn, spend, history, forecasts and chart series | 120 deterministic randomized scenarios captured from the original Node implementation, including complete outputs. |
| Roles, offices, products, purchases, counts, settings, activity, CSV, access and proposals | 85 sequential Node service contracts replayed against both SQLite and real PostgreSQL; additional validation/transaction regression tests. |
| HTTP contract | All 44 original method/path pairs matched; request/response, status, errors, permissions, CSRF, headers, cookies, uploads/downloads, limits and SSE exercised by Python HTTP tests and real browser requests. |
| Existing credentials and cutover | Node scrypt hashes, JWTs and encrypted tokens verified and reproduced byte-for-byte with fixed randomness/time. A captured Node session, chosen password and pending setup ticket survive reopening the database in Python; refresh rotates and preserves encrypted Graph credentials. |
| Identity and cloud storage | Real RSA-signed test ID tokens; PKCE/state/nonce, issuer/audience/tenant, signature, expiry, guest/domain refusal, Graph refresh/filtering and immutable Blob SDK calls tested without cloud credentials. |
| Transactions and migration | Real PostgreSQL contract replay; cross-connection refresh reuse; induced receipt/audit failure; SQLite-to-PostgreSQL copy/rollback, password/receipt preservation, immutable upload retries, nonempty destination refusal and session exclusion. |
| Operations | Release allowlist and actual Python startup/restart/static serving; root npm commands, production configuration rejection, clean dependency install, audits and workflow YAML validated locally. GitHub-hosted execution will occur when the changes are pushed. |

The contract corpus normalizes generated UUIDs and one-time invite passwords. PostgreSQL audit rows with identical timestamps are compared as a multiset because the original query does not define their tie order. API keys, real accounts, live databases and cloud resources are never used as fixtures. These checks provide regression evidence, not a proof over every possible input or an Azure acceptance result.

## Baseline and reproduction

The original source baseline is commit `275a403b659f2289ecf0e901769e145238e721e7`; its 42 tests and original browser script passed on Node 24.21.0 before removal. The checked-in synthetic corpus needs no Node backend to run. To recapture it deliberately, check out that original revision separately, run `npm ci` there, then run these from the current repository with Node 24:

```sh
node scripts/capture-node-baseline.mjs /absolute/original-checkout /absolute/output/node-contracts.json
node scripts/capture-node-session.mjs /absolute/original-checkout /absolute/output/node-session.json
```

Review fixture changes before replacing the checked-in expectations. Do not regenerate expected results from the Python implementation. Normal verification commands are in [README.md](../README.md#verify-changes).

An extra browser check confirmed that **the original Node app also returns to sign-in if the page is reloaded during password setup**. The uninterrupted invite/setup flow is preserved and tested; changing that existing behavior was kept outside this migration. The existing frontend also reloads activity when its office/date filters change, and deterministic factual chat recognizes its original starter product names. Frontend source has not been altered to add new behavior.

## Cutover and remaining external work

The repository migration is complete. The following production acceptance work remains separate from local verification:

- [ ] Run real Entra sign-in and optional Graph consent against the intended tenant.
- [ ] Verify Azure PostgreSQL TLS/private networking and Blob managed identity with the packaged Python release.
- [ ] Rehearse restart, backup/restore and any approved data cutover on staging copies; measure realistic load.
- [ ] Deploy through the approved release process after staging acceptance.

These require the actual deployment environment. No production deployment or live data migration was performed. Follow [Azure deployment](AZURE_DEPLOYMENT.md) for Python App Service runtime/startup, Oryx installation, same-database cutover, and the separate SQLite-to-PostgreSQL migration. Preserve `SESSION_SECRET` and retain the old data/backup until an explicitly planned cutover is complete.

## Handoff

The repository migration was reviewed on 29 September 2026 before it was committed. The review covered transactions, refresh reuse, CSRF and cookies, receipt rollback, chat confirmations, PostgreSQL SQL translation, release startup, and the `client/` to `frontend/` move. No defect turned up beyond what the suite already locks. The 28 original frontend source and asset files remain byte-for-byte identical.

Verification run again on Python 3.12.3, Node 24.21.0, and local PostgreSQL 15.3:

- **209 tests passed**, no skips, including real PostgreSQL.
- `npm run build` passed.
- Chrome browser suite passed, including the diagnostic redaction of synthetic invite passwords, at desktop width and 390px.
- `pip check`, `pip-audit`, and `npm audit --audit-level=high` reported no known vulnerabilities.
- `python scripts/package_release.py` staged a clean release. `PYTHONPATH=backend python -m pantry --reload` answered `/api/health`.

GitHub-hosted checks run on push. They install Chromium and PostgreSQL 16, repeat these checks, and upload `pantry-python-release`. They do not deploy. Existing ignored `server/data/` and its backup stay in place.

### What remains

Complete the external staging checklist above using [Azure deployment](AZURE_DEPLOYMENT.md): real Entra/Graph consent, PostgreSQL TLS/private networking, Blob managed identity, restart/restore, and load tests. Mocks cannot establish those. Keep the existing session secret and database during a same-database backend cutover. Never point tests at the live `DATABASE_URL`.

```sh
# Run from the accounts-agent repository root, with Node 24 selected.
python3.12 -m venv backend/.venv                 # only if the environment is missing
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
# Alternatively use installed Chrome: PANTRY_BROWSER_CHANNEL=chrome npm run test:browser
backend/.venv/bin/python -m pip check
backend/.venv/bin/python -m pip_audit -r backend/requirements.txt --no-deps --disable-pip
npm audit --audit-level=high
backend/.venv/bin/python scripts/package_release.py
```

The packaging command requires an absent or empty `release/` directory and refuses to overwrite existing contents. Local setup already exists in `backend/.venv`; do not recreate it unnecessarily. This machine's default Node may not be 24; select Node 24 before verification. The original Node checkout used for the baseline was temporary. The recorded Git revision `275a403b659f2289ecf0e901769e145238e721e7` and the synthetic fixtures are the durable baseline.

Browser tests choose a free port. Leave any existing development server on port 5173 alone.

```sh
# Run from the accounts-agent repository root, with Node 24 selected.
python3.12 -m venv backend/.venv                 # only if the environment is missing
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
# Alternatively use installed Chrome: PANTRY_BROWSER_CHANNEL=chrome npm run test:browser
backend/.venv/bin/python -m pip check
backend/.venv/bin/python -m pip_audit -r backend/requirements.txt --no-deps --disable-pip
npm audit --audit-level=high
backend/.venv/bin/python scripts/package_release.py
```

The packaging command requires an absent or empty `release/` directory and refuses to overwrite existing contents. Local setup already exists in `backend/.venv`; do not recreate it unnecessarily. This machine's default Node was 23, so verification used temporary Node 24.21.0 at `/private/tmp/pantry-node-runtime/node_modules/node/bin/node`. Select/install Node 24 normally when resuming; temporary paths may disappear. The original Node checkout was preserved temporarily at `/private/tmp/pantry-node-baseline`; the recorded Git revision and synthetic fixtures are the durable baseline.

No task-owned test process was pending at the stopping point. A pre-existing user development process on port 5173 was deliberately left alone. Browser tests choose a free port and do not require stopping that process.
