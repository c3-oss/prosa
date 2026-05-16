---
type: qa-report
created: 2026-05-16
agent: codex
source: Playwright MCP browser pass after local login
---

# Prosa web console navigation QA - 2026-05-16

## Scope

Browser-only pass after creating an account through `/signup` and logging in through `/login`.

Credentials used for this pass:

```text
email: prosa-web-qa-20260516-0042@example.com
tenant: Prosa QA Tenant
slug: prosa-qa-20260516-0042
```

Important setup note:

- Login only worked after restarting `apps/web` with `VITE_PROSA_API_URL=http://localhost:3000` and serving web from `http://localhost:5173`.
- The earlier combination `web=http://localhost:5173` and `api=http://127.0.0.1:3000` returned 200 on sign-in but left the browser unauthenticated.

Current local default:

- `@c3-oss/prosa-web` now serves Vite on `localhost` and defaults the API URL to `http://localhost:3000` in development.
- Keep both web and API hostnames on `localhost` unless explicitly testing a full `127.0.0.1` setup.

## Login result

Status: login works when web and API both use `localhost`.

Observed behavior:

- Submitted `/login` with the credentials above.
- Browser navigated to `/console`.
- Sidebar showed the authenticated email.
- Sidebar showed one tenant option: `Prosa QA Tenant (prosa-qa-20260516-0042)`.

Remaining issue:

- Resolved by adding and linking the web SVG favicon.

## Confirmed console issue

### QA-009 - Tenant switcher shows a tenant, but content routes behave as if no tenant is active

Severity: product blocker for an empty/new account and likely for any single-tenant user.

Observed behavior:

- The sidebar tenant switcher displays `Prosa QA Tenant (prosa-qa-20260516-0042)` selected.
- The tenant switcher is disabled because there is only one tenant.
- Every tenant-scoped content route shows a “Pick a tenant to continue” empty state.
- Settings shows `Tenant: —` and `Your role: unknown`.

Impact:

- The user appears to have a tenant but cannot use the console.
- Because the only tenant switcher is disabled, there is no visible way to activate/select the tenant.
- The empty-state copy tells the user to pick a tenant, but the UI prevents doing that.

Likely behavior gap:

- The auth/session payload contains tenant membership but no active tenant id, or the web context mirrors only `me.tenantId` and does not fall back to the sole tenant in `me.tenants`.
- The tenant switcher visually selects the sole tenant, but the route guards/query enablement still see `tenantId = null`.

## Screen-by-screen notes

### Dashboard - `/console`

Observed:

```text
Pick a tenant to continue
Use the tenant switcher to choose an active tenant. Console reads are tenant-scoped.
```

Problem:

- Contradicts the sidebar, which already shows the tenant selected.
- No onboarding guidance for “no data yet, run prosa sync” is reachable because tenant state is missing.

### Sessions - `/console/sessions`

Observed:

```text
Pick a tenant to continue
Sessions are tenant-scoped.
```

Problem:

- No session table or empty synced-data state is shown.
- Expected for a new tenant would be an empty state that references `prosa auth login && prosa sync push`, not a tenant-selection blocker.

### Search - `/console/search`

Observed:

- Search form is visible.
- Submitting `codex` updates the URL to `/console/search?q=codex`.
- Results area still shows:

```text
Pick a tenant to continue
Search is tenant-scoped.
```

Problem:

- The search box accepts input even though the route cannot execute a search without tenant state.
- This creates a dead-end interaction: the query is accepted but no useful result or tenant remediation appears.

### Tool calls - `/console/tool-calls`

Observed:

- “Errors only” checkbox is visible.
- Results area shows:

```text
Pick a tenant to continue
Tool calls are tenant-scoped.
```

Problem:

- Filter controls are enabled while the underlying route is blocked by missing tenant state.

### Analytics - `/console/analytics`

Observed:

- Report selector buttons are visible: `sessions`, `tools`, `errors`, `models`, `projects`.
- The `sessions` report is selected.
- Results area shows:

```text
Pick a tenant to continue
Analytics is tenant-scoped.
```

Problem:

- Report selector appears actionable even though all report queries are blocked by missing tenant state.

### Settings - `/console/settings/team`

Observed:

```text
Tenant: — · Your role: unknown
Read-only role
Members can view team membership but cannot invite users or change roles. Ask an admin or owner to invite teammates.
```

Problem:

- The signed-up user created the tenant but is shown as unknown/read-only.
- No invite form appears.
- This makes the first user of a tenant look unauthorized in their own tenant.

## Usability summary

The shell of the console is usable after the localhost-only login workaround: navigation, sidebar, route changes, and basic form controls render. The product experience is still blocked because tenant activation/state is inconsistent. The UI simultaneously communicates “you have this tenant” in the sidebar and “you have no active tenant” in the content.

## Recommended fixes

1. On signup, ensure the created tenant becomes active for the browser session.
2. On login, if the user has exactly one tenant and no active tenant, automatically set it active or have the web client call the active-tenant mutation.
3. Do not disable the tenant switcher if the active tenant id is missing, even when there is only one tenant.
4. Align sidebar and content state so both derive from the same active tenant source.
5. Replace “Pick a tenant” on single-tenant accounts with an actionable recovery button, for example “Use Prosa QA Tenant”.
6. Hide or disable search/filter/report controls when tenant state is missing, or show a clear banner explaining that the tenant must be activated first.
7. Fix first-owner role display in Settings so the tenant creator is not shown as `unknown`/read-only.
