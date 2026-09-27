# Accounts and Inventory agent

This file is the source of truth for any coding agent working in this repo. Read it before editing. If a linked file covers the area you are about to change, read that file too.

Keep this file under 32kb. Put extra durable notes in a sibling markdown file and link it from the section it belongs to. Do not create a second guide that contradicts this one.

## Which folder

Work only in `C:\Users\SiddharthKalyani(Dat\Projects\Acocunts Agent`.

The folder name is spelled Acocunts. That spelling is the real deliverable. Do not rename it.

`Projects\Acocunts Agent - MVP` is the frozen local demo. Do not edit it, do not start it, and do not copy new work back into it. Both apps use ports 5173 and 8787, so only one may run.

## What this product is

Intuitive's internal pantry tracker for every office a Super Admin adds. People record products, purchases, and shelf counts. The server computes on-hand stock, burn rate, expected run-out, status, and monthly spend. The browser displays those figures.

Client: React and Vite, `client/`, http://127.0.0.1:5173/

API: Express, `server/index.js`, http://127.0.0.1:8787/

Data: SQLite at `server/data/pantry.sqlite` via `node:sqlite` `DatabaseSync`. Tests pass `PANTRY_DB`.

Start from this folder with `npm run dev`. `npm start` is the API only. `npm run build` builds the client.

Shell on this machine is PowerShell. Do not use `&&`. Chain with `;`.

## Documents

`documents/Accounts_and_Inventory_Management_Agent_Scope_and_BRD.pdf` is the client scope and business requirements (cover: Version 1.0, draft for review, 24 September 2026, Confidential). Do not edit, rewrite, or replace that PDF unless the user asks. Scope text stays undated in new writing; calendar dates belong in a schedule, not in the scope.

Phase 1 architecture, plain text, stays at `C:\Users\SiddharthKalyani(Dat\Downloads\Accounts_and_Inventory_Management_Agent_Phase_1_Architecture_Requirement.txt`. The project schedule stays at `Downloads\Accounts_and_Inventory_Management_Agent_Project_Schedule.docx`.

Phase names use a colon. Phase 1: Pantry expense management. Phase 2: One dashboard. Phase 3: Campus drives.

Assets, punches, swag, and campus drives are not built. The assistant, charts, and next-month forecast are already in this pantry app because the user asked for them here. Leave them in place. The architecture text calls forecast and chatbot Phase 2. That note does not authorize removing them.

Where this repo and that architecture text disagree, keep the behavior in this file until the user changes it:

- Admin sees every office, including All offices, and cannot add offices, assign roles, or change pantry rows.
- A confirmed chat can soft-delete one product, one purchase, or one shelf count.
- Hide and restore controls are not on screen. The API routes still exist.

## Theme, binding on every UI change

The visual system is already chosen. New screens, components, and states must use it. Do not introduce a second palette, a second font, a gradient, a card style from another product, or a component library skin.

Source of truth for tokens: `client/src/styles.css`. Use the variables. Do not hard-code a new hex when a variable exists.

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

Font is Satoshi only, files in `client/public/fonts/`: Light 300, Regular 400, Medium 500, Bold 700, Black 900. Body size is 16px. Do not load Inter, Roboto, Arial, or a webfont from a third party.

Logos and marks, `client/public/brand/`:

- Top bar and the dark sign-in hero: `/brand/logo-on-dark.svg` on black (`#000`). The top bar stays black in light and dark.
- Light surfaces that need a logo: `/brand/logo-on-light.svg`.
- Favicon: `/brand/Intuitive Favicon Primary.svg`.
- Do not redraw the logo, recolor it, or substitute a wordmark.

Theme choice is `localStorage` key `aim-theme`: `light`, `dark`, or `system`. Default is light. `client/index.html` applies it before paint. `documentElement.dataset.theme` is `light` or `dark`. `dataset.themeChoice` keeps the user's choice. System follows `prefers-color-scheme`.

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
- Money is INR through `rupee()` in `client/src/api.js`. Dates display as India dates. Empty money and dates currently render a dash. New client sentences do not use an em dash. Role and status copy uses "No" or a full sentence.
- Copy is short, concrete, and in the voice already on the screen. No model name, no "how this was worked out", no chart methodology essay.

When a UI change is made, open http://127.0.0.1:5173/ and use the feature the way a person would. Check the other screens that share the component or the data. Check a desktop width and a 390px width. Fix what breaks before finishing.

## Access

Sign-in accepts only `@intuitive.AI`, case-insensitive. Guests and other domains are refused. A person who has not been invited cannot enter, even with a valid Microsoft login.

Two ways in, same allowlist:

- Email and password on the sign-in page.
- Microsoft, via the button. It works only after `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, and `ENTRA_CLIENT_SECRET` are set. Redirect URI is `http://127.0.0.1:5173/api/auth/callback`. Do not print those values. Do not remove the Microsoft button.

Invite flow, Super Admin only, Access screen:

- Enter an `@intuitive.AI` email. The API returns a one-time password once. The Super Admin sends it by hand.
- That password is stored only as a scrypt hash. The person signs in with it and lands on the set-password page with the email filled in. They confirm a new password.
- Someone who already chose a password is not issued another invite over the top.

Chosen passwords: at least 12 characters, at most 128, one uppercase, one lowercase, one number, no leading or trailing space, not a common password, and not containing the mailbox name. The new password must differ from the invite password. Five wrong attempts lock the account for 15 minutes.

Seeded Super Admin: `Siddharth.Kalyani@intuitive.AI`. Production databases start with that person and no offices. Fixture mode (`PANTRY_SEED=fixtures` or `openDatabase(file, { seed: "fixtures" })`) is for tests only. Do not turn fixture seed on in `.env`.

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
- Refresh token, 30-day sliding window, 90-day absolute cap, HttpOnly cookie `aim_refresh` on `/api/auth`. Each refresh rotates it. Reuse of an old refresh token revokes that session family.
- CSRF token comes from `GET /api/me` and is sent as `X-CSRF-Token` on writes. The client retries once through `POST /api/auth/refresh` on a 401.
- Do not store the session in `sessionStorage` or `localStorage`.
- Cookies are `SameSite=Lax`. `Secure` is on when `APP_ORIGIN` is https.
- Password hashes use scrypt N=32768, r=8, p=1. A stored hash with different parameters is rejected.

## Pantry rules that tests already lock

Calculations live in `server/calc.js`. Do not reimplement them in the client.

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
- A failed receipt upload still keeps the purchase. Receipts are PDF, JPEG, or PNG, checked from the file bytes, at most 10MB, stored under `server/data/receipts`, and downloaded only by someone who can view that office, as an attachment.
- Chat stock questions are answered by `factualReply` in `server/chat.js` from live pantry data, before any model call.
- The model is TokenRouter at `https://api.tokenrouter.com/v1/chat/completions`, model `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, key in `OPENROUTER_API_KEY` or `TOKENROUTER_API_KEY`. Do not print the key. Do not set `NODE_TLS_REJECT_UNAUTHORIZED`. This app deletes that variable for its own processes.
- Replies stream over `POST /api/chat` when `stream` is true. SSE events are `thread`, `delta`, `replace`, `done`, and `error`. The JSON path remains.
- Follow-ups stay on `threadId`. Errors still return `threadId`.
- One product, one purchase, or one shelf count can be deleted from chat only after the assistant says the data will be deleted and the person says yes. Accounts and Admin are refused. Hide, restore, wipe, rename, and receipt-only delete stay refused. Weather and other non-pantry topics are refused.
- Propose tools prepare a card. Nothing is saved until the person confirms or says yes.
- Opening the pantry page does not call the model.

## Security habits

- Parameterized SQL only. Authorize every route. Super Admin checks live on the server, not only in the nav.
- Unknown failures return "Something went wrong." Do not send stack traces, tokens, or password hashes to the client.
- Do not log invite passwords, session cookies, refresh tokens, or the API key.
- Rate limits exist on login, refresh, and the API. Keep them.
- Bind the API to `127.0.0.1` unless `WEBSITE_SITE_NAME` or `PANTRY_HOST` says otherwise.
- `.env`, `server/data/`, and `node_modules/` stay untracked. `server/data/pantry.sqlite.mvp-backup` is the old demo database. Do not delete it and do not point the app at it.

## Tests and commits

`npm test` runs, in this folder:

- `server/calc.test.js`
- `server/identity.test.js`
- `server/password.test.js`
- `server/service.test.js`
- `server/chat.scope.test.js`

Before any commit, run the whole suite. All of it must pass. Do not commit a red suite, a skipped file, or a focused `only` test.

When you change calculation, stock, spend, auth, invites, roles, chat scope, delete confirmation, or an API status code, add or update a test that fails if the old bug returns. Then run the whole suite, not only the new file.

Tests use temporary sqlite files. They must not open `server/data/pantry.sqlite`.

A UI change is not done when the suite is green alone. Also use the screen, as the theme section says.

Do not commit secrets, the live database, or a generated invite password. Write commit messages that say what changed for the pantry, not a transcript of the session.

## Layout of the code

- `server/calc.js` computes. `server/service.js` stores and authorizes. `server/chat.js` answers. `server/passwords.js` hashes passwords and signs tokens. `server/identity.js` checks the Microsoft identity. `server/entra.js` runs the Microsoft login. `server/index.js` is the HTTP surface. `server/http.js` and `server/secret.js` are headers, cookies, and encryption.
- `client/src/screens/Dashboard.jsx` is the shell. `SignIn.jsx` is sign-in and set-password. `OfficeBar.jsx` switches offices and adds an office. `AccessPanel.jsx` invites and assigns roles. `RecordPanel.jsx` records. `PantryCharts.jsx` draws charts. `ChatPanel.jsx` is the assistant.
- Record kinds are Purchase, Count, Product, and Settings for a Super Admin. There is no Office kind on that form. Offices are added from the office bar. All offices cannot record. The bar must name one office first.

## Do not

- Do not restart or edit the MVP app.
- Do not put demo people, demo purchases, or a local email picker back on the sign-in page.
- Do not widen access past `@intuitive.AI` people a Super Admin has invited.
- Do not show the model name, a chain of thought, or a long method note in the UI.
- Do not hard-delete pantry rows.
- Do not change on-hand or burn math without a failing test that proves the new rule, then the full suite.
