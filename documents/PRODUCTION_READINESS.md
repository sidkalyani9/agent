# Phase 1 production-readiness review

## Release status

Application changes and local verification are complete for the approved scope. This is **ready for Azure staging validation, not an assertion that an unconfigured Azure deployment is production-ready**. No cloud resources were provisioned, no real Microsoft authorization flow was exercised, and no live data was migrated during this review.

The original BRD is unchanged. Product hiding was explicitly excluded by the owner; product editing and receipt retrieval were approved and added. Existing forecasting, charts and the pantry assistant remain in place. The repository's deliberate role policy remains: Admin is read-only across all offices; Office Manager writes only assigned offices.

## Phase 1 coverage

| Requirement | Implementation / verification |
| --- | --- |
| Office creation, assignment and isolation | Server authorization, Super Admin controls, five starter products with zero opening counts in a transaction. SQLite, PostgreSQL and HTTP checks. |
| Products and reorder settings | Add products; new Stock-screen editing for name, reorder packs and warning effective days. Duplicate names rejected ignoring case. No hiding controls added. |
| Purchases and optional receipts | Server validates date/packs/price, maintains attribution, uses idempotent purchase submission. Bad receipt leaves purchase saved. Receipt metadata and audit changes are atomic. |
| Retrieve receipts | New monthly Purchases and receipts list and authenticated attachment downloads. Office access checked on the server; files are not exposed through a public static directory. |
| Counts, stock, burn and alerts | Existing server calculation rules preserved, including same-day count semantics, India dates, two purchase-month minimum, configurable weekend weight and lookback. Regression suite retained. |
| Monthly spend and download | Server-computed totals and CSV export. Text cells are neutralized against spreadsheet formulas. |
| Activity and historical records | Attributed operations and soft-deletion behavior retained. No hard-delete UI added. |
| Identity and roles | Invited `@intuitive.AI` members only. Microsoft tenant/audience/issuer/object identity checks; production rejects missing or guest account-type claims. Local passwords remain allowed without MFA. |
| Persistent sessions | Rotating HttpOnly cookies; 90-day inactivity and 180-day absolute limits. Two-tab refresh coordination, stable family CSRF, server revocation and replay detection. |
| Availability and performance targets | Not yet demonstrated on Azure. BRD targets include 99.5% office-hours availability, dashboard p95 below 2 seconds, saves below 1 second, and assistant replies below 8 seconds. Measure in staging. A free external AI provider cannot be assumed to satisfy its target. |

## Confirmed issues fixed

These findings were checked against executable tests or actual browser behavior. They are not claims that the app had every common vulnerability.

| Finding and impact | Fix / evidence |
| --- | --- |
| Old credentials could survive disabling then re-enabling a person, or reissuing an invite. This could restore access to someone who still held an old session/setup ticket. | Revoke access families, legacy sessions and setup tickets together. Security regression tests cover both flows. |
| Restarting could restore a bootstrap Super Admin grant that another administrator had removed. | Bootstrap only an empty people database. Restart regression preserves the removed privilege. |
| Inactive Super Admins were counted when protecting the last administrator. | Count active people with live grants; tests prevent disabling/removing the final active Super Admin. |
| A role snapshot could remain usable after the grant was removed. | Re-read live identity and grants inside service operations. A stale actor cannot write after revocation. |
| Chat confirmation could affect a pending action from another conversation. | Bind proposals and confirmations to the owner and thread; expire them after 30 minutes. Regression covers a deletion proposed in one chat and “yes” in another. |
| Product names could become spreadsheet formulas in exported CSVs. | Escape dangerous text-cell prefixes; regression includes a HYPERLINK formula. |
| Production origin/proxy assumptions were too permissive. | Exact HTTPS production origin, rejection of missing/cross-site origins on writes, trusted App Service client IP handling instead of caller-supplied forwarded headers. Unit and HTTP checks. |
| Concurrent tabs could trigger refresh replay detection and unexpectedly sign the user out; the cookie lifetime also did not match the requested policy. | Browser-wide Web Locks coordination and a recheck before rotation; tested two expired-access tabs cause one refresh. Tests cover 90/180-day boundaries. |
| Impossible dates, oversized values and malformed JWT headers were insufficiently handled. | Calendar/bounds validation and safe JWT rejection; regressions cover each. |
| Production CSP blocked the inline theme bootstrap; the mobile menu backdrop blocked Log out. | External theme script and corrected stacking order, verified at desktop and 390px widths. |

The review also added fail-closed production configuration, generic unexpected errors, seven-day invitation expiry, account-aware chat rate limits, a common-password variant check, immutable receipt names, PostgreSQL transactions and a source-preserving migration tool. No SQL-injection or unauthenticated receipt-download exploit was established in the tested paths; authorization and parameterization were preserved and regression-tested.

## Verification evidence

- Full automated suite: 42 tests passing, no skipped or focused tests.
- PostgreSQL: syntax, case-insensitive uniqueness, transactions, sessions, concurrent refresh reuse, scoped writes, exports and chat ordering exercised with PGlite.
- Migration: pantry data, chosen password hashes and receipt mapping preserved; nonempty destination refused; induced failure rolls back database rows; sessions deliberately excluded.
- Real local HTTP server: unauthenticated/forbidden access, CSRF, role checks, receipt upload/download, bad-file handling and refresh replay.
- Real Chromium browser: password login, product edit, receipt download, shared screens, theme persistence, two-tab refresh, simulated return using persisted cookies, mobile layout and logout.
- Production client build succeeds. Dependency audit reports zero known vulnerabilities at review time. This is not a guarantee against unknown vulnerabilities or a substitute for a penetration test.

All automated data is disposable. Azure TLS/network/firewall/managed identity and a real Entra sign-in still require the deployment checklist.

## Accepted risks and operational gaps

1. **Local password login has no MFA**, as explicitly requested. An attacker with that password can log in despite Microsoft MFA. Use unique password-manager-generated passwords and tightly control Super Admin grants.
2. **Long-lived sessions on personal devices** increase exposure if a device/browser is stolen or compromised. The app cannot prevent a malicious browser extension or OS from using an authenticated session. Browser cookie deletion or unsupported cross-tab locking can cause earlier sign-in.
3. **Offboarding must disable the person in this app**, not only in Entra. Existing app sessions and the independent local password are not continuously revalidated against Microsoft account status. Disable immediately; it revokes all app sessions and setup tickets.
4. **Password recovery/change is explicitly deferred by the owner.** An already-set local password has no reset screen in this release; Microsoft sign-in remains an alternative. Do not improvise direct database edits. Keep a compromised local account disabled until credentials are safely replaced. The planned follow-up is listed below.
5. **Receipts are type/size checked, not malware-scanned.** They download as attachments. Consider Defender for Storage and an actual quarantine/release integration if company policy requires scanning; merely enabling an alert is not a download gate.
6. **External AI is optional.** Leave the key unset until the company approves its data processing. The provider can receive the caller's display name/email, authorized pantry context and chat text. It is not Azure-hosted merely because the app is. No spending hard cap or provider availability commitment is implemented.
7. **One app instance initially.** IP/chat rate limits are in memory and reset on restart. Database authorization/refresh serialization works across instances, but multi-instance abuse quotas need shared storage or an upstream limit before scaling out. The database lock is intentionally coarse for this small workload; measure real load before increasing concurrency.
8. **Audit history is application-level**, not cryptographically tamper-proof against a database administrator. Backups, restricted Azure roles and protected logs are operational requirements. Authentication tokens, chat history and audit records need an agreed retention policy; no business-record cleanup job is enabled automatically.

## Release gates still owned by deployment

- Choose an approved region, budget, recovery window and operational owner; no region or bill was assumed.
- Complete [Azure deployment](AZURE_DEPLOYMENT.md), including private database/storage access, identity/RBAC, secret resolution, HTTPS, backups and alerts.
- Test real Microsoft member, guest, uninvited, disabled and wrong-tenant scenarios; verify the `acct` claim is present.
- Test a restart/redeployment with the same secrets and database; signed-in users should remain signed in.
- Rehearse migration on a copy, then test a database-and-receipt restore. Record measured recovery time and acceptable data loss.
- Test at 20 concurrent users and realistic receipt sizes; validate the BRD performance targets instead of assuming them.

## Future work, explicitly deferred

- Local password change and Super Admin–issued one-time password reset. The reset should revoke every session and setup ticket, expire promptly, require a new chosen password, and record an audit event. Not implemented in this release, per the owner's instruction. Do not confuse a password reset with re-enabling an account or issuing a first-time invitation.
