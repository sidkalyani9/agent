# Deploy the pantry to Azure

This is a first-deployment runbook for the approved managed App Service + PostgreSQL design. Nothing here has been provisioned on your behalf. Use a staging environment first, with separate secrets and test data. Do not upload the local database or `.env` with the application.

## 1. What goes where

| Part of this app | Azure service | Initial sizing / purpose |
| --- | --- | --- |
| React website and FastAPI together | App Service, Linux, Python 3.12 | One Basic B1 instance as an initial sizing hypothesis for 10–20 people. Enable Always On. Measure before changing size. |
| Users, roles, sessions, pantry, chat and activity | Azure Database for PostgreSQL Flexible Server | Smallest available General Purpose size in the chosen region, typically 2 vCores; start with minimum supported storage and storage-growth alerts. |
| Receipt files | Storage account, general-purpose v2, Blob Storage | Standard storage, private `receipts` container, managed-identity access. LRS is the lower-cost baseline; choose ZRS if zone resilience is required and supported. |
| App secrets | Key Vault | Session-signing secret, database connection URL, Entra client secret; optional AI key. |
| App-to-data network | Virtual Network | App Service integration subnet, PostgreSQL delegated subnet, and a separate private-endpoint subnet for Blob. |
| Operational checks | Azure Monitor and Application Insights | Health, failures, latency, resource usage, budget and secret-expiry alerts. Set retention and sampling deliberately. |

This app does not need Kubernetes, a VM for hosting, Redis, a separate frontend host, a GPU, or an Azure AI resource just to run Phase 1. Requests to the existing external AI provider are optional. Keeping client and API on one origin simplifies secure cookies and deployment.

Basic App Service supports VNet integration. General Purpose PostgreSQL is the production recommendation; Microsoft explicitly cautions against Burstable for production because exhausted CPU credits can cause severe degradation. A cheap Burstable database can be used for staging, but should not silently become the production choice. These are sizing recommendations, not measured capacity guarantees. [App Service networking](https://learn.microsoft.com/en-us/azure/app-service/overview-vnet-integration), [PostgreSQL compute guidance](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-compute).

The database will likely be the largest fixed cost. Before buying, compare regional prices in the Azure Pricing Calculator, including backups, private endpoints, logs and any high-availability option. No precise monthly price is quoted because region, currency, subscription pricing and recovery requirements are undecided. A single instance without database HA saves money but does not provide zone-failure resilience.

## 2. Decisions and access to obtain first

Ask your company's Azure/IT administrator for:

1. The correct Azure subscription and permission to create resources and grant resource-scoped roles.
2. An approved region/data-residency choice. Keep the app, database and storage in the same region. Do not assume India is required solely because pantry dates use India time.
3. A monthly budget and acceptable downtime/data-loss window. Set budget notifications before provisioning; budget alerts do not automatically stop spending.
4. Permission to register an Entra application, create its credential, and configure optional claims. Directory search is optional and needs separate consent.
5. A secure way for the deployment operator to reach the private database: an existing company VPN/peered network or a controlled VNet-connected administration environment. Ordinary Cloud Shell and a laptop do not automatically have that access. Do not solve this by opening PostgreSQL to the entire Internet.

Use MFA on Azure administrator accounts. Keep application users separate from Azure resource administrators. Create a resource group such as `rg-pantry-prod`; use distinct names/resources for staging. These names are examples, not resources that already exist.

## 3. Create the web app and Microsoft registration

In Azure Portal, create **Web App**:

- Publish: Code. OS: Linux. Runtime: Python 3.12. Select the agreed region and a B1 App Service plan, one instance.
- Record its actual default HTTPS hostname. It may include an automatically generated suffix; copy it from Overview rather than guessing it.
- Under Identity, enable **System assigned** and save. Record its principal/object ID for later role assignments.
- Under configuration/general settings: Always On enabled, HTTPS Only enabled, minimum TLS at least 1.2 (1.3 where supported), remote debugging off, FTP off, SCM and FTP basic publishing authentication off.
- Use a single-process startup command: `bash startup.sh`. Do not enable multiple Uvicorn workers or several instances at this stage. The startup script defaults to port 8000, and the app binds to all interfaces on App Service; do not set the local `PANTRY_HOST=127.0.0.1` in Azure.
- Leave App Service Authentication / Easy Auth unconfigured: this application already implements Microsoft and password sign-in. Requiring Microsoft's platform login in front would remove the independent password option you asked to keep.

Confirm Python 3.12 is available in the selected App Service environment and verify the deployed runtime. A custom startup command is required for this FastAPI app. [Python hosting configuration](https://learn.microsoft.com/en-us/azure/app-service/configure-language-python).

In **Microsoft Entra ID → App registrations → New registration**:

1. Choose accounts in **this organizational directory only**.
2. Add a **Web** redirect URI: `https://ACTUAL-APP-HOST/api/auth/callback`. It must match the configured canonical app origin exactly. Do not enable implicit grant as a workaround.
3. Record the Directory/tenant ID and Application/client ID. Create a client secret; store its **value** in Key Vault, not in Git. Set an expiry reminder with time to rotate.
4. Under Token configuration, add optional claim **`acct` to the ID token**. Production intentionally requires `acct: 0` for a tenant member and rejects a guest or a missing claim. Verify the emitted token through a real login without logging the token.
5. Find the seeded Super Admin in Entra Users and copy that **user's Object ID**. This is not the app registration's object ID. Configure it as `SEED_SUPERADMIN_OBJECT_ID`, paired with the intended sign-in name.
6. If IT uses enterprise-app assignment and Conditional Access, assign the intended people and enforce its Microsoft MFA policy. App invitations/grants are still required. This does not add MFA to local password login.
7. Only if directory search is wanted, grant the delegated Microsoft Graph permission `User.ReadBasic.All` with tenant-approved consent. Otherwise Super Admin can invite an exact company sign-in name manually; do not grant broader directory permissions by default.

Microsoft's [optional-claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference) documents `acct`; immutable `oid`/tenant binding matters more than a display email. Domain membership alone never authorizes access to this app.

## 4. Create the private database and receipt storage

Create a VNet in the same region. Use separate, non-overlapping subnets for App Service integration, PostgreSQL and private endpoints. Have IT choose address ranges compatible with its networks. Configure App Service → Networking → VNet integration with the app subnet; do not place PostgreSQL in that subnet.

Create **Azure Database for PostgreSQL Flexible Server**:

1. Select General Purpose sizing as above and a supported PostgreSQL major version. Keep auto-grow/storage alerts configured. Discuss HA separately against your availability/budget requirement.
2. Select private access/VNet integration and the database-only delegated subnet. Create/link the corresponding private DNS zone to the VNet. Keep the database off public access; do not enable the broad “allow Azure services” shortcut.
3. Enable automated backup retention of 35 days if the agreed policy allows it. The supported range is 7–35 days. Decide whether geographic backup redundancy is required when provisioning.
4. Create a dedicated database and role. Never put the server administrator's connection string in the web app. From a trusted, VNet-connected `psql` session authenticated as the database administrator, an example is:

```sql
CREATE ROLE pantry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password pantry_app
CREATE DATABASE pantry OWNER pantry_app;
\connect pantry
REVOKE ALL ON DATABASE pantry FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO pantry_app;
```

`\password` prompts rather than embedding a password in shell history. Use a generated unique password. This application currently creates/upgrades its own schema at startup, so its dedicated database role needs schema DDL privileges; it is not a read-only or CRUD-only account. Limit that role to this app's database and do not claim that runtime and migration credentials are separated.

The connection secret is `postgresql://pantry_app:URL_ENCODED_PASSWORD@ACTUAL-DB-HOST:5432/pantry`. URL-encode username/password special characters. The app verifies the server's TLS certificate in production even if somebody adds insecure SSL flags. Do not disable verification to make a failed connection work. [Private database networking](https://learn.microsoft.com/en-us/azure/postgresql/network/concepts-networking-private), [backup/restore](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore).

Create a **Storage account** and the **`receipts` Blob container**:

- Disable anonymous blob access; container access level is Private. Require HTTPS and TLS 1.2 or better. Disable shared-key authorization after confirming managed-identity administration works.
- Add a Blob private endpoint in the private-endpoint subnet; link its private DNS zone to the app VNet. Verify resolution/access from the app, then disable public network access. “Private container” and “private network endpoint” are different controls; configure both.
- Give the web app's system-assigned identity **Storage Blob Data Contributor** scoped to this container, not Owner on the subscription. The application accesses receipts itself and rechecks office permissions; do not generate public receipt URLs or browser SAS tokens.
- Enable blob versioning, blob soft delete and container soft delete; for example, 35-day retention aligned with database recovery. Add a resource deletion lock and restrict who can remove it. Do not add an age-based lifecycle rule that deletes live receipts.
- These settings protect recovery; they do not implement malware quarantine. Assess Defender for Storage if company policy requires scanning. [Blob security guidance](https://learn.microsoft.com/en-us/azure/storage/blobs/secure-blobs).

## 5. Put secrets and settings in place

Create a Key Vault with Azure RBAC, soft delete and purge protection. Give the web app identity **Key Vault Secrets User**, not an administrative role. Only designated operators should be able to write secrets.

For a simple baseline, Key Vault's authenticated HTTPS endpoint with RBAC can remain network-accessible; it is not anonymous/public secret access. If company policy requires a private endpoint/firewall, configure its private DNS and App Service routing too. Linux App Service private-vault references require route-all configuration; have IT verify external connectivity to Entra and the AI provider and account for any NAT cost. Do not blindly block all outbound traffic. [Key Vault references and networking](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references).

Create secrets for `pantry-session-secret`, `pantry-database-url` and `entra-client-secret`. Generate the session secret with a password manager or 48 random bytes encoded as base64url; it must contain at least 48 characters. Keep it stable across restarts and deployments. Rotating it intentionally logs users out and invalidates encrypted directory tokens; it is not a routine build-time value.

Open App Service → Environment variables / Application settings and copy the keys from [`.env.production.example`](../.env.production.example), replacing placeholders. The essential mapping is:

| Setting | Value |
| --- | --- |
| `APP_ENV` | `production` (`NODE_ENV=production` also enables production guardrails) |
| `APP_ORIGIN` | Exact canonical HTTPS origin, no path or trailing slash |
| `ENTRA_REDIRECT_URI` | Same origin plus `/api/auth/callback` |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` | IDs from app registration |
| `SEED_SUPERADMIN_EMAIL`, `SEED_SUPERADMIN_NAME`, `SEED_SUPERADMIN_OBJECT_ID` | Intended bootstrap administrator, including Entra user's immutable object ID |
| `SESSION_SECRET`, `DATABASE_URL`, `ENTRA_CLIENT_SECRET` | Key Vault references, not literal placeholders |
| `AZURE_STORAGE_ACCOUNT_URL` | Actual `https://ACCOUNT.blob.core.windows.net` endpoint |
| `AZURE_STORAGE_CONTAINER` | `receipts` |
| `TOKENROUTER_API_KEY` | Empty initially; later a Key Vault reference only after company approval |

A Key Vault reference looks like `@Microsoft.KeyVault(SecretUri=https://VAULT.vault.azure.net/secrets/pantry-session-secret/)`. Check the portal reports **resolved**. An unresolved reference is not the secret value. Do not set `PANTRY_SEED=fixtures`, `PANTRY_DB`, `PGSSL=disable`, `NODE_TLS_REJECT_UNAUTHORIZED`, or the local host/port overrides. The app fails startup when required production settings are absent.

Choose one canonical hostname before launch. Adding a custom domain later requires matching HTTPS certificate, `APP_ORIGIN`, Entra callback and user bookmarks; cookies are host-specific, so moving hosts requires another login.

## 6. Build and deploy code

The local `.github/workflows/checks.yml` runs tests/build/browser checks and a production dependency audit; it does not deploy anything. Make it a required check on the protected release branch. A workflow file alone does not enable branch protection.

For a first deployment, use App Service **Deployment Center → GitHub → GitHub Actions**, after deciding which private repository/branch to connect. Choose OpenID Connect / managed identity, not a long-lived publish profile. Creating this connection can commit a generated workflow to your repository: review it before enabling automatic production deployment. Protect production with a GitHub environment approval. Limit the deployment identity to the web app's required deployment role, not subscription Owner. [Microsoft deployment instructions](https://learn.microsoft.com/en-us/azure/app-service/deploy-github-actions).

The repository's checks workflow already installs Python 3.12 and Node 24, starts disposable PostgreSQL 16, builds the frontend, runs the complete Python and browser suites, audits dependencies, and uploads `pantry-python-release`. The workflow has read-only repository permission and contains no cloud credentials. Any future deployment job must depend on these checks and consume the tested artifact.

For manual preparation, run the complete [README verification commands](../README.md#verify-changes), then:

```sh
python scripts/package_release.py
```

Run that with the project's Python environment active. The script stages an allowlisted `release/` and refuses to overwrite a nonempty destination. Its contents are `backend/pantry/`, `frontend/dist/`, root `requirements.txt` and `startup.sh`. It excludes local data, secrets, virtual environments, Node dependencies and tests. Node is needed only to build/test the frontend.

Deploy the **contents of `release/`**, using the generated `azure/webapps-deploy` step's `package: release`. Set **`SCM_DO_BUILD_DURING_DEPLOYMENT=true`** so Oryx installs the pinned root `requirements.txt` on Linux, and set startup command **`bash startup.sh`**. Do not upload a macOS virtual environment. Oryx installs dependencies during deployment and activates the runtime environment; this package intentionally does not ship a preinstalled environment. [Python build automation](https://learn.microsoft.com/en-us/azure/app-service/configure-language-python#customize-build-automation).

When replacing an existing Node deployment, change the App Service runtime to Python 3.12 and replace the PM2 startup command. Preserve the database URL, private receipt container and `SESSION_SECRET`. The database schema, password hashes, JWTs and refresh families are compatible, so a backend replacement using the **same database** does not intentionally log people out. SQLite-to-PostgreSQL migration is a separate operation below, which deliberately excludes sessions. Never run both backends as writers during cutover.

If importing existing data, complete step 7 into an empty database **before the first app startup seeds it**. Keep the web app stopped until migration has finished. For a brand-new empty pantry, skip migration and let the first startup initialize the schema and the configured administrator. Releasing new code must never overwrite a data directory because persistent production data lives in PostgreSQL and Blob.

Check Log stream for successful startup and `GET /api/health` for HTTP 200 and `{"ok":true}`. Health only checks database connectivity, not Blob access or Microsoft login. If startup fails, fix configuration/DNS/RBAC; do not switch off production validation.

## 7. Migrate existing SQLite data, only if needed

This migration is not automatic. Rehearse on a copy and compare totals before scheduling the final move.

1. Stop the old app and all writers. Take an SQLite-consistent backup using the SQLite backup API/command, or copy the database **and its sidecar files after a clean shutdown**. Copy the receipts folder at the same time. Do not copy only a running WAL-mode `.sqlite` file. Preserve the original offline backup.
2. In a private administration environment with this repository, Node 24 and dependencies, check the source without connecting to a target:

```sh
PYTHONPATH=backend python -m pantry.migration /absolute/backup/pantry.sqlite /absolute/backup/receipts
```

3. This checks integrity, required tables and receipt existence/size, and reports counts only. Demo fixture identities are refused. A source with an older/incompatible schema must be reviewed/upgraded on a copy, not “fixed” by altering the live original.
4. Prepare an **empty** target database. Do not start the app first: its seeded person makes the target nonempty, and the migration will refuse it. Never delete real target data to get around this guard.
5. In the secure operator environment, supply the real `DATABASE_URL`, `AZURE_STORAGE_ACCOUNT_URL` and `AZURE_STORAGE_CONTAINER` as process environment variables using approved secret tooling. The CLI script does not load `.env`. Authenticate to Azure as an operator with container-scoped Blob Data Contributor access; it uses `DefaultAzureCredential` outside App Service. The operator must also have network access to the private database/blob endpoint. Use production TLS checks, never `PGSSL=disable` against Azure.
6. Execute against the reviewed backup:

```sh
PYTHONPATH=backend python -m pantry.migration /absolute/backup/pantry.sqlite /absolute/backup/receipts --execute
```

7. The tool uploads immutable/checksummed receipt objects, inserts metadata in a transaction and verifies table row counts. It preserves password hashes, people, grants and business data. It does **not** transfer active sessions, password-setup tickets, login attempts or pending chat confirmations: everyone signs in afresh. Existing invitations still obey their original seven-day expiry.
8. On failure the source is unchanged and database inserts roll back; unreferenced blobs can remain and safe retries verify content instead of overwriting it. The tool intentionally does not print raw driver errors that could contain secrets. Check secure connectivity and source/target state before retrying.
9. Start the new app. Compare office/product/purchase/count totals, sampled month exports, attribution and receipt downloads. Keep the old app stopped so there is only one source of truth. Retain the old backup until the approved retention period ends.

An existing database's administrator grants are preserved, not overridden by seed settings. Verify at least two trusted active Super Admins before cutover. Changing the seed settings on a populated database does not restore a removed administrator.

## 8. Staging acceptance and go-live

Do not skip this because local tests passed:

- Microsoft login succeeds for an invited member, and fails for guests, uninvited people, wrong tenant and disabled app users. Verify `acct` configuration and immutable identity binding.
- Local invite → temporary password → chosen password works; the invite cannot be reused after setup/reissue/expiry. Test wrong-password throttling without locking out the only administrator.
- In browser developer tools, confirm access and refresh cookies are HttpOnly, Secure and SameSite=Lax, with the refresh path `/api/auth`. Do not copy real cookie values into tickets or chat.
- Close/reopen the browser, open two tabs after access expiry, and restart/redeploy the app. Sessions survive while allowed; logout and app-account disable revoke access. Browser cookie clearing is an expected exception.
- Test Super Admin, Admin, assigned Office Manager and Accounts separately, including direct requests to another office's data/receipts. Hiding UI remains absent.
- Record purchases/counts, edit a product, download a monthly CSV and retrieve an actual Blob receipt. Public/anonymous Blob access must fail. Simulate a receipt-storage error and confirm the purchase survives.
- Test desktop and mobile. Check Microsoft redirects, CSP console errors and the streaming assistant if enabled.
- Use disposable staging data for a 20-user load check, including common office NAT addresses and realistic receipts. Measure dashboard p95 and save time against the BRD, with separate upload latency. Do not claim the AI's response target without measuring its actual provider.
- Perform the restore rehearsal below and record results. Obtain owner sign-off for remaining risks in [the review](PRODUCTION_READINESS.md).

B1 has no deployment slots. Use a separate staging web app/database/container, or budget for a tier with slots if slot-based releases are required. Staging must not share production data or cookies. For a small single-instance deployment, schedule code releases for a quiet period; restart downtime is not zero.

## 9. Operations, recovery and offboarding

Set App Service health check to `/api/health`. Turn on Application Insights server monitoring through the portal where supported, validate that requests are actually arriving, and create alerts for health failure/5xx, latency, CPU/memory, PostgreSQL connections/storage, Blob failures, secret expiry and monthly spend. Avoid collecting passwords, cookies, OAuth codes, receipt contents or chat bodies. Review automatic URL-query collection, especially `/api/auth/callback`, before enabling telemetry. Use conservative retention/sampling; log ingestion can outgrow the app's compute cost.

Back up **both metadata and receipts**. Database backup does not include Blob files. PostgreSQL point-in-time restore creates another server; rehearse restoration to an isolated environment, grant the right network access, update its test connection secret, and verify sampled records and receipts. Immutable receipt paths let restored metadata refer to older objects if those objects were retained. Preserve the signing/encryption secret in protected Key Vault recovery as well. [PostgreSQL restore behavior](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore).

For an ordinary faulty code release, redeploy the previous known-good application artifact with compatible schema. Do not restore the database merely to roll back a UI change. For data recovery, stop writers, choose a recovery point, reconcile any lost entries, restore/test, then cut over under an explicit recovery plan. Record actual recovery time and data loss; backup settings alone do not prove recoverability.

When somebody leaves or a device is lost, a Super Admin must **disable the person in this app immediately**. This revokes every app session and setup ticket. Disabling only their Entra account does not invalidate local passwords or these app-owned long sessions. Keep a compromised account disabled until its password and identity are safely recovered. Local password change/reset is on the owner's future-work list, not implemented in this release; Microsoft login is the current alternative for a forgotten local password.

Maintain two trusted active Super Admins. Keep dependency checks, Python 3.12 runtime patches and Node 24 build-tool patches current, review grants periodically, and rehearse recovery after major infrastructure changes. Before adding app instances or Uvicorn workers, replace per-process abuse limits with shared/upstream limits and load-test database contention. Do not add Redis or more instances preemptively for a 10–20-user pantry.
