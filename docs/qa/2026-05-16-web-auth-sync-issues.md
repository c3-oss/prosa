---
type: qa-report
created: 2026-05-16
agent: codex
source: manual local Docker Compose + Playwright MCP + pnpm dev CLI
---

# Prosa web/auth/sync QA issues - 2026-05-16

## Scope

Manual local pass using Docker Compose for API/Postgres/MinIO, Vite for `apps/web`, Chrome through Playwright MCP, and the CLI through `pnpm dev -- ...` from this repository.

Local store safety constraint: do not remove or purge `~/.prosa`; intended sync command must use `--keep-local`.

## Environment used

- API: `docker compose up --build` from repo root.
- Web: `pnpm --filter @c3-oss/prosa-web dev`.
- CLI: `pnpm dev -- auth ...` and intended `pnpm dev -- sync --keep-local ...`.
- Browser: Chrome controlled via Playwright MCP.

## Confirmed issues

### QA-001 - `localhost:5173` can resolve to the wrong app when another Vite server is bound to IPv6

Severity: setup blocker.

Observed behavior:

- Prosa web initially listened on `127.0.0.1:5173`.
- Another local app, Vogal, listened on `*:5173` via IPv6.
- Opening `http://localhost:5173` loaded Vogal instead of Prosa.

Evidence:

```text
node ... /Users/upsetbit/Projects/c3/c3-oss/vogal/apps/frontend/.../vite.js dev
node ... /Users/upsetbit/Projects/c3/c3-oss/prosa/apps/web/.../vite.js --host 127.0.0.1
```

Impact:

- Local QA is confusing: `localhost` and `127.0.0.1` are not interchangeable in practice.
- Auth/CORS behavior changes depending on the host used in the browser.

Workaround used:

- Stopped the Vogal processes.
- Restarted Prosa web with `--host localhost`.

Follow-up fix:

- `@c3-oss/prosa-web` now starts Vite with `--host localhost` by default.

### QA-002 - Docker Compose API CORS defaults do not accept `http://127.0.0.1:5173`

Severity: web signup blocker when using `127.0.0.1`.

Observed behavior:

- Opening Prosa web at `http://127.0.0.1:5173/signup` and submitting signup failed with `Failed to fetch`.
- Browser console showed the API returned `Access-Control-Allow-Origin: http://localhost:5173`, which did not match origin `http://127.0.0.1:5173`.

Evidence:

```text
Access to fetch at 'http://127.0.0.1:3000/trpc/auth.signupWithTenant?batch=1' from origin 'http://127.0.0.1:5173' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: The 'Access-Control-Allow-Origin' header has a value 'http://localhost:5173' that is not equal to the supplied origin.
```

Impact:

- The default local browser path fails unless the exact origin expected by the API is used.
- The visible UI error is generic (`Failed to fetch`) and does not tell the user how to fix the setup.

Workaround used:

```bash
docker compose -f docker-compose.yml -f /tmp/prosa-compose-web-origin.yml up -d --force-recreate api
```

With override:

```yaml
services:
  api:
    environment:
      PROSA_WEB_ORIGIN: "http://127.0.0.1:5173,http://localhost:5173"
```

Follow-up fix:

- The web development default API URL is now `http://localhost:3000`, matching the default Vite host used by the web dev script.
- Local web QA should open `http://localhost:5173` and keep the API URL on `http://localhost:3000` unless testing `127.0.0.1` explicitly on both sides.

### QA-003 - Signup succeeds but redirects to login instead of landing authenticated in the console

Severity: medium UX issue.

Observed behavior:

- Signup through `/signup` succeeded and created the user/tenant.
- The app redirected to `/login` immediately after signup.
- No success confirmation or next-step guidance was shown.

Account created during this pass:

```text
email: prosa-web-qa-20260516-0042@example.com
tenant: Prosa QA Tenant
slug: prosa-qa-20260516-0042
```

Impact:

- Users have to log in manually right after account creation.
- If login is broken, the user is blocked immediately after a successful signup.

### QA-004 - Browser login returns 200 but the app remains unauthenticated

Severity: product blocker.

Observed behavior:

- Login form posted to `/api/auth/sign-in/email`.
- API returned HTTP 200.
- The app stayed on `/login` with fields reset.
- `auth.me` immediately afterward still returned 401.
- Navigating directly to `/console` redirected back to `/login`.
- No visible error message appeared on the login page.

Evidence from API logs:

```text
POST /api/auth/sign-in/email -> 200
GET /trpc/auth.me?batch=1&input=%7B%7D -> 401 Authentication required
```

Impact:

- The browser console is inaccessible even with valid credentials.
- The user gets no actionable feedback because the login form does not surface the failed session state.

Likely contributing factor from the first run:

- Web was served from `localhost:5173`, while the API client was configured as `http://127.0.0.1:3000`. This can break browser cookie/session behavior even when CORS succeeds.

### QA-005 - CLI `auth login` fails against the local API with `Missing or null Origin`

Severity: sync blocker.

Observed behavior:

Both variants failed:

```bash
pnpm dev -- auth login --server http://127.0.0.1:3000 --email prosa-web-qa-20260516-0042@example.com --password prosa-web-qa-password
pnpm dev -- auth login --server http://localhost:3000 --email prosa-web-qa-20260516-0042@example.com --password prosa-web-qa-password
```

Both returned:

```text
sign-in failed: 403 {"message":"Missing or null Origin","code":"MISSING_OR_NULL_ORIGIN"}
```

Impact:

- The documented path `prosa auth login && prosa sync push` is blocked.
- `sync --keep-local` could not be executed because no CLI auth token was acquired.

### QA-006 - CLI `auth device-login` returns a malformed verification URL

Severity: auth blocker.

Observed behavior:

```bash
pnpm dev -- auth device-login --server http://127.0.0.1:3000 --json --poll-max-seconds 60
```

Output:

```json
{"kind":"device-code","userCode":"L8ELDAWK","verificationUri":"http://localhost:3000/http://localhost:3000/device","expiresIn":1800,"interval":5}
```

Opening the URL returned 404:

```json
{"message":"Route GET:/http://localhost:3000/device not found","error":"Not Found","statusCode":404}
```

Impact:

- Device login cannot be completed by following the CLI instructions.
- The URL appears to double-prefix the origin.

### QA-007 - CLI device-login polling hits rate limit before the user can complete approval

Severity: auth blocker.

Observed behavior:

After polling for the device login attempt, the CLI exited with:

```text
auth.deviceToken: Rate limit exceeded. Retry after 10s.
```

Impact:

- The CLI treats a rate-limit response as fatal instead of backing off and continuing.
- Combined with the malformed verification URL, the device flow is currently unusable.

### QA-008 - Browser and server logs contain noisy expected failures during normal auth route loads

Severity: low to medium, depending on monitoring/noise tolerance.

Observed behavior:

- Browser console reports favicon 404.
- Login/signup route load logs `auth.me` 401 before a user is authenticated.
- API logs the unauthenticated `auth.me` probes at error level with stack traces.
- API startup logs many migration/table/index `already exists, skipping` notices.
- Better Auth logs a warning that rate limiting skipped because client IP could not be determined.

Impact:

- Normal unauthenticated app loads look like errors.
- Real failures are harder to distinguish from expected control flow.
- Local developer confidence is reduced during QA.

## Sync status

Follow-up fix for low-noise browser setup:

- `apps/web` now links a simple SVG favicon so normal page loads do not emit the missing favicon request.

`pnpm dev -- sync --keep-local` was not reached. The sync path is blocked by CLI authentication failures. No local store cleanup command was run, and `~/.prosa` was not removed.

## Suggested fix order

1. Make web/API local origins deterministic in compose/dev docs and defaults.
2. Fix browser login session persistence when web and API run locally.
3. Fix CLI email/password login so it works without a browser `Origin` header, or provide a dedicated CLI-safe token endpoint.
4. Fix device-login verification URI construction.
5. Make device-login polling handle rate limits by backing off.
6. Reduce expected unauthenticated `auth.me` noise and startup migration notice noise.
7. Add a clear post-signup success path: either land authenticated in console or show explicit “account created, now sign in” state.
