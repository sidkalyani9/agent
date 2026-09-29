# Accounts and Inventory agent

This file is the source of truth for any coding agent working in this repo. Read it before editing. If a linked file covers the area you are about to change, read that file too.

Keep this file under 32kb. Put extra durable notes in a sibling markdown file and link it from the section it belongs to. Do not create a second guide that contradicts this one.

## Which folder

Work in this repository's root, using the workspace path and shell supplied by the current environment. Older project notes refer to a Windows folder named `Acocunts Agent`; do not assume that absolute path exists on another machine or rename the project to match it.

Any sibling `Acocunts Agent - MVP` is the frozen local demo. Do not edit it, start it, or copy new work back into it. Development uses ports 5173 and 8787, so only one app may use those ports.

## What this product is

Intuitive's internal pantry tracker for every office a Super Admin adds. People record products, purchases, and shelf counts. The server computes on-hand stock, burn rate, expected run-out, status, and monthly spend. The browser displays those figures.

Client: React and Vite, `frontend/`, http://127.0.0.1:5173/

API: Python/FastAPI, `backend/pantry/app.py`, http://127.0.0.1:8787/

Data: new checkouts use SQLite at `backend/data/pantry.sqlite`. Existing `server/data/` remains the default when present; `PANTRY_DATA_DIR` can explicitly override it. Never silently initialize an empty pantry beside existing data. Production uses PostgreSQL through `DATABASE_URL` and Azure Blob for receipts. `backend/pantry/database.py` exposes asynchronous operations and connection/transaction scopes; await service calls. Passing an explicit database filename always selects SQLite, keeping tests off the production database.

Use Python 3.12 for the backend and Node.js 24 LTS for frontend tooling. Install the virtual environment/dependencies as described in README.md. Start from this folder with `npm run dev`. `npm start` runs the API and serves `frontend/dist` when built. `npm run build` builds the client.

Use commands appropriate to the environment's actual shell. Do not infer PowerShell from old Windows paths.

## Documents

`documents/Accounts_and_Inventory_Management_Agent_Scope_and_BRD.pdf` is the client scope and business requirements (cover: Version 1.0, draft for review, 24 September 2026, Confidential). Do not edit, rewrite, or replace that PDF unless the user asks. Scope text stays undated in new writing; calendar dates belong in a schedule, not in the scope.

Older notes refer to a Phase 1 architecture text and project schedule in the author's Windows Downloads folder. Those are external documents, not guaranteed to exist in this checkout.

[Production readiness](documents/PRODUCTION_READINESS.md) records verified findings, approved exclusions and outstanding release gates. [Azure deployment](documents/AZURE_DEPLOYMENT.md) covers the approved App Service + PostgreSQL design, migration, secrets and recovery. Read the relevant document before changing production behavior or deployment guidance. Do not call Azure integration verified solely because local tests pass.

Phase names use a colon. Phase 1: Pantry expense management. Phase 2: One dashboard. Phase 3: Campus drives.

Assets, punches, swag, and campus drives are not built. The assistant, charts, and next-month forecast are already in this pantry app because the user asked for them here. Leave them in place. The architecture text calls forecast and chatbot Phase 2. That note does not authorize removing them.

Where this repo and that architecture text disagree, keep the behavior in this file until the user changes it:

- Admin sees every office, including All offices, and cannot add offices, assign roles, or change pantry rows.
- A confirmed chat can soft-delete one product, one purchase, or one shelf count.
- Hide and restore controls are not on screen, explicitly excluded by the owner. The authorized API routes still exist. Product editing and monthly receipt retrieval are on screen.

## Theme, binding on every UI change

The visual system is already chosen. New screens, components, and states must use it. Do not introduce a second palette, a second font, a gradient, a card style from another product, or a component library skin.

Source of truth for tokens: `frontend/src/styles.css`. Use the variables. Do not hard-code a new hex when a variable exists.

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` | `#f3f3f1` | `#0c0c0c` |
| `--paper` | `#ffffff` | `#161616` |
| `--ink` | `#111111` | `#f5f5f3` |
| `--muted` | `#5e5e5e` | `#b0b1b1` |
| `--line` | `#e3e3e0` | `#2a2a2a` |
| `--accent` | `#e90003` | `#e90003` |
| `--hero` | `#0c0c0c` | `#000000` |
| `--soft` | `#f7f7f5` | `#101010` |

Accent `#e90003` is for small marks only: the sign-in kicker, focus ring, eyebrows, and status highlights. Do not fill large areas with red. Do not change the accent.

Font is Satoshi only, files in `frontend/public/fonts/`: Light 300, Regular 400, Medium 500, Bold 700, Black 900. Body size is 16px. Do not load Inter, Roboto, Arial, or a webfont from a third party.

Logos and marks, `frontend/public/brand/`:

- Top bar and the dark sign-in hero: `/brand/logo-on-dark.svg` on black (`#000`). The top bar stays black in light and dark.
- Light surfaces that need a logo: `/brand/logo-on-light.svg`.
- Favicon: `/brand/Intuitive Favicon Primary.svg`.
- Do not redraw the logo, recolor it, or substitute a wordmark.

Theme choice is `localStorage` key `aim-theme`: `light`, `dark`, or `system`. Default is light. `frontend/index.html` loads the external `frontend/public/theme.js` before paint so it works under production CSP. `documentElement.dataset.theme` is `light` or `dark`. `dataset.themeChoice` keeps the user's choice. System follows `prefers-color-scheme`.

Shape and chrome:

- Corner radius is 4px. Shadows stay soft and neutral.
- Primary button is `.solid`: ink fill, paper text. Dark theme flips that pair to `#f5f5f3` on `#111`.
- Secondary actions use `.ghost` or `.texty`.
- Focus uses `outline: 2px solid var(--accent)`.
- The app shell is `100dvh`. Only `.page` scrolls. Do not put a second page scrollbar on `body`.
- Content width sits near `min(1180px, 100%)`.
- Left nav: Record, Stock, Charts, Activity. Super Admin also gets Access. The assistant is not a nav item.
- Assistant is the round launcher at the bottom right (`ChatDock`).
- Active nav item uses the ink fill, same as `.solid`.
- Money is INR through `rupee()` in `frontend/src/api.js`. Dates display as India dates. Empty money and dates currently render a dash. New client sentences do not use an em dash. Role and status copy uses "No" or a full sentence.
- Copy is short, concrete, and in the voice already on the screen. No model name, no "how this was worked out", no chart methodology essay.

When a UI change is made, open http://127.0.0.1:5173/ and use the feature the way a person would. Check the other screens that share the component or the data. Check a desktop width and a 390px width. Fix what breaks before finishing.

## Access

Sign-in accepts only `@intuitive.AI`, case-insensitive. Guests and other domains are refused. A person who has not been invited cannot enter, even with a valid Microsoft login.

Two ways in, same allowlist:

- Email and password on the sign-in page.
- Microsoft, via the button. It works only after `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, and `ENTRA_CLIENT_SECRET` are set. Redirect URI is `http://127.0.0.1:5173/api/auth/callback`. Do not print those values. Do not remove the Microsoft button.

Production uses the exact HTTPS origin/callback instead, requires the member `acct: 0` optional ID-token claim and the seed administrator's Entra user Object ID. Keep both login methods. The owner explicitly chose no MFA for local password login; do not describe Microsoft MFA as protecting that route.

Invite flow, Super Admin only, Access screen:

- Enter an `@intuitive.AI` email. The API returns a one-time password once. The Super Admin sends it by hand.
- That password is stored only as a scrypt hash. The person signs in with it and lands on the set-password page with the email filled in. They confirm a new password.
- Someone who already chose a password is not issued another invite over the top.
- An invite expires after seven days. Reissuing one revokes earlier setup tickets and sessions. Disabling a person revokes all app sessions/tickets; re-enabling must not revive them.
- Local password change and Super Admin password reset are explicitly deferred to future work by the owner. Do not add a reset workflow without a new request. Microsoft login remains the alternative for a forgotten local password; compromised local accounts must remain disabled until safely recovered.

Chosen passwords: at least 12 characters, at most 128, one uppercase, one lowercase, one number, no leading or trailing space, not a common password, and not containing the mailbox name. The new password must differ from the invite password. Five wrong attempts lock the account for 15 minutes.

Seeded Super Admin: `Siddharth.Kalyani@intuitive.AI`. Production databases start with that person and no offices. Fixture mode (`PANTRY_SEED=fixtures` or `await open_database(file, seed="fixtures")`) is for tests only. Do not turn fixture seed on in `.env`.

Roles are grants in the app, not Entra roles:

| Role | Sees | Writes pantry | Adds offices | Invites and assigns roles |
| --- | --- | --- | --- | --- |
| Super Admin | Every office and All offices | Yes | Yes | Yes |
| Admin | Every office and All offices | No | No | No |
| Office Manager | Assigned offices | Those offices | No | No |
| Accounts | Assigned offices | No | No | No |

One office shows a label. More than one office shows one searchable dropdown, not a row of buttons. All offices is only on the Super Admin and Admin dropdown. An office the caller cannot open returns not found.

Sessions:

- Access JWT, 15 minutes, HttpOnly cookie `aim_access`.
- Refresh token, 90-day sliding inactivity window, 180-day absolute cap, HttpOnly cookie `aim_refresh` on `/api/auth`. Each refresh rotates it and the cookie lifetime is capped by absolute expiry. Reuse of an old refresh token revokes that session family.
- CSRF token comes from `GET /api/me` and is sent as `X-CSRF-Token` on writes; it stays stable within a session family. The client retries once on a 401 or explicit CSRF mismatch. Refresh uses Web Locks across tabs and rechecks the access cookie after acquiring the lock. Transient network/server errors must not clear valid cookies or pretend logout succeeded.
- Do not store the session in `sessionStorage` or `localStorage`.
- Cookies are `SameSite=Lax`. `Secure` is on when `APP_ORIGIN` is https.
- Password hashes use scrypt N=32768, r=8, p=1. A stored hash with different parameters is rejected.
- Keep production `SESSION_SECRET` stable across deployments. App offboarding must disable the person in the app, not only in Microsoft; these sessions are app-owned.

## Pantry rules that tests already lock

Calculations live in `backend/pantry/calc.py`. Do not reimplement them in the client.

- A count on a date already includes purchases dated that day.
- On-hand walks from the day after the count. Each day adds that day's purchases, then subtracts burn times that day's weight.
- Weekdays weigh 1. Weekends weigh the company weekend weight, default 0.20, range 0 to 1. Lookback default is 3 months, range 2 to 36.
- Burn needs two months with purchases in the lookback window. Otherwise status is Not enough history.
- The chart spike for a purchase is on the purchase date. The count marker stays at the counted packs.
- A purchase dated after the count must not be folded back into the count or into the burn rate.
- "The office is shut for N more working days" changes only that chat reply's expected date. The screen date does not change and nothing is saved.
- Status is Due when on-hand is at or below the reorder level, or the expected date is inside the warning window.
- Dates and "today" use Asia/Kolkata. Purchase and count dates cannot be after today in India.
- A new office starts with Coffee, Milk, Sugar, Tea, and Sticks at zero, each with an opening count, in one transaction.
- Product names are unique per office, ignoring case.
- Spend is packs times price per pack on purchases that are not soft-deleted. Amounts are INR.
- Nothing in pantry stock is hard-deleted. Hide, withdraw, and remove set `deleted_at` and `deleted_by`.
- `created_by` and `created_at` stay as first written.
- A failed receipt upload still keeps the purchase. Receipts are PDF, JPEG, or PNG, checked from the file bytes, at most 10MB, stored locally under `PANTRY_DATA_DIR/receipts` (new default `backend/data`, or existing `server/data`) or in private Azure Blob Storage. Immutable versioned object names preserve older receipts for backup recovery. Downloads require office access and are attachments. Type checks are not a malware scanner.
- Chat stock questions are answered by `factual_reply` in `backend/pantry/chat.py` from live pantry data, before any model call.
- The model is TokenRouter at `https://api.tokenrouter.com/v1/chat/completions`, model `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, key in `OPENROUTER_API_KEY` or `TOKENROUTER_API_KEY`. Do not print the key. Do not set `NODE_TLS_REJECT_UNAUTHORIZED`. This app deletes that variable for its own processes.
- Replies stream over `POST /api/chat` when `stream` is true. SSE events are `thread`, `delta`, `replace`, `done`, and `error`. The JSON path remains.
- Follow-ups stay on `threadId`. Errors still return `threadId`.
- One product, one purchase, or one shelf count can be deleted from chat only after the assistant says the data will be deleted and the person says yes. Accounts and Admin are refused. Hide, restore, wipe, rename, and receipt-only delete stay refused. Weather and other non-pantry topics are refused.
- Propose tools prepare a card. Nothing is saved until the person confirms or says yes.
- A confirmation belongs to its owner and chat thread, and expires after 30 minutes. A yes in another conversation must not apply it. Recheck live roles inside service operations, including after model calls.
- Opening the pantry page does not call the model.

## Security habits

- Parameterized SQL only. Authorize every route. Super Admin checks live on the server, not only in the nav.
- Unknown failures return "Something went wrong." Do not send stack traces, tokens, or password hashes to the client.
- Do not log invite passwords, session cookies, refresh tokens, or the API key.
- Rate limits exist on login, refresh, and the API. Keep them.
- Bind the API to `127.0.0.1` unless `WEBSITE_SITE_NAME` or `PANTRY_HOST` says otherwise.
- `.env`, `backend/data/`, legacy `server/data/`, Python virtual environments, and `node_modules/` stay untracked. `server/data/pantry.sqlite.mvp-backup` is the old demo database. Do not delete it and do not point the app at it.
- Production startup requires HTTPS, PostgreSQL, Blob configuration, strong session secret and Microsoft credentials; fixtures are forbidden. Never weaken those checks to make deployment work.
- Preserve transaction scopes and parameterized values when changing SQLite/PostgreSQL queries. App Service starts with one process/instance; rate limits are per-process. Do not scale out without revisiting abuse limits and load-testing the coarse database lock.

## Tests and commits

`npm test` runs the complete Python suite in `backend/tests/`: calculation/service golden contracts captured from Node, auth, live roles, inventory, HTTP/security, chat/SSE, Microsoft/Graph/Blob mocks, real PostgreSQL and packaged runtime startup. Build the frontend before the full suite (`npm run build`). [Migration evidence](documents/PYTHON_MIGRATION.md) records the baseline and coverage.

Before any commit, run the whole suite. All of it must pass. Do not commit a red suite, a skipped file, or a focused `only` test.

When you change calculation, stock, spend, auth, invites, roles, chat scope, delete confirmation, or an API status code, add or update a test that fails if the old bug returns. Then run the whole suite, not only the new file.

Tests use temporary SQLite files and real isolated PostgreSQL databases. Install PostgreSQL binaries locally or set `PANTRY_TEST_POSTGRES_URL` to a disposable test service; the suite must fail, not skip, if unavailable. They must not open `server/data/pantry.sqlite` or use real Azure credentials. PostgreSQL tests prove engine behavior, not Azure networking/TLS. Run `npm run build` and `npm run test:browser` for client changes; the latter starts temporary FastAPI on a free loopback port and needs Playwright Chromium (or `PANTRY_BROWSER_CHANNEL=chrome`).

A UI change is not done when the suite is green alone. Also use the screen, as the theme section says.

Do not commit secrets, the live database, or a generated invite password. Write commit messages that say what changed for the pantry, not a transcript of the session.

## Layout of the code

- `backend/pantry/calc.py` computes. `core.py` handles schema, time and live authorization. `accounts.py`, `inventory.py` and `conversations.py` store and authorize their own operations. `chat.py` answers and calls model tools. `passwords.py` hashes passwords/signs tokens; `identity.py` checks Microsoft claims; `entra.py` performs OIDC/PKCE and Graph calls.
- `app.py`, `auth_routes.py`, `routes.py` and `chat_routes.py` expose HTTP and SSE. `http.py` enforces headers, cookies, rate limits and CSRF; `secret.py` handles compatible token encryption. `compat.py` preserves JavaScript numeric/text semantics where required by the existing contract.
- `config.py` validates production settings; `database.py` provides SQLite/PostgreSQL scopes and nested transactions; `receipts.py` provides immutable local/managed-identity Blob I/O. `python -m pantry.migration` (with `PYTHONPATH=backend`) performs explicit, source-preserving migration to empty PostgreSQL. Never run execution against live data without the user's cutover authorization.
- Root scripts are convenience/build tooling. `scripts/package_release.py` stages only Python runtime, requirements, startup and frontend assets; production does not need Node. CI tests Python 3.12, PostgreSQL and Node 24, then uploads a release artifact without deploying it.
- `frontend/src/screens/Dashboard.jsx` is the shell. `SignIn.jsx` is sign-in and set-password. `OfficeBar.jsx` switches offices and adds an office. `AccessPanel.jsx` invites and assigns roles. `RecordPanel.jsx` records. `PantryCharts.jsx` draws charts. `ChatPanel.jsx` is the assistant.
- `ProductEditor.jsx` edits name/reorder/warning in Stock. `Purchases.jsx` lists monthly purchases and retrieves receipts through authenticated API requests.
- Record kinds are Purchase, Count, Product, and Settings for a Super Admin. There is no Office kind on that form. Offices are added from the office bar. All offices cannot record. The bar must name one office first.

## Do not

- Do not restart or edit the MVP app.
- Do not put demo people, demo purchases, or a local email picker back on the sign-in page.
- Do not widen access past `@intuitive.AI` people a Super Admin has invited.
- Do not show the model name, a chain of thought, or a long method note in the UI.
- Do not hard-delete pantry rows.
- Do not change on-hand or burn math without a failing test that proves the new rule, then the full suite.
