# Intuitive pantry

Phase 1 pantry expense management for invited Intuitive employees. React displays stock and spend calculated by the Express API. Microsoft and local password sign-in share the same app-owned access list.

- [Production review and remaining release gates](documents/PRODUCTION_READINESS.md)
- [Azure deployment, migration and recovery guide](documents/AZURE_DEPLOYMENT.md)
- [Original scope / BRD](documents/Accounts_and_Inventory_Management_Agent_Scope_and_BRD.pdf)
- [Contributor rules](AGENTS.md)

## Run locally

Use Node.js 24 LTS (`.nvmrc`). Copy `.env.example` to a private `.env` and configure Microsoft sign-in if needed. Do not use production credentials for local tests.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Development uses SQLite under `server/data/`. The first real database contains only the configured Super Admin, with no offices or demo transactions. There is no default production password: first access is through that person's configured Microsoft identity.

For the built client:

```sh
npm run build
npm start
```

The Express server serves `client/dist` as well as `/api`. Set `APP_ORIGIN` and the Microsoft callback to the actual browser origin when running without Vite.

## Verify changes

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm audit
```

Browser tests start an isolated fixture app on port 5173; stop the development server first. If Chrome is already installed, `PANTRY_BROWSER_CHANNEL=chrome npm run test:browser` can use it. Tests use temporary databases and receipt folders, never the live pantry. PostgreSQL tests use the PGlite PostgreSQL engine; they do not replace testing Azure networking, TLS and managed identity.

## Production shape

One Linux Azure App Service hosts the built React client and Express API. Azure Database for PostgreSQL Flexible Server stores application data and sessions. A private Azure Blob container stores receipts; Key Vault stores secrets. Start with one application instance for 10–20 users. See the deployment guide before setting `NODE_ENV=production`: the server deliberately refuses insecure or incomplete production configuration.

Sessions use 15-minute access cookies and rotating refresh cookies with 90 days of inactivity / 180 days absolute lifetime. Cookies, browser privacy settings, account revocation, and security incidents can require an earlier sign-in. Password login has no MFA by the owner's explicit choice; Microsoft MFA does not protect that alternative login path.
