# Web platform deployment

This document describes how to deploy the prosa web platform — the
`@c3-oss/prosa-api` server and the `@c3-oss/prosa-web` static SPA — in
production. It is the canonical operational reference for lane 08.

## Topology

Recommended deployment shape:

```text
+-----------+        cookie auth         +-----------------+
| browser   | <------ HTTPS ----------> | apps/api server |
| (apps/web)|                            | (Fastify+tRPC)  |
+-----------+                            +-----------------+
       |                                          |
       |                          drizzle         |
       |                                          v
       |                                  +---------------+
       |                                  |  Postgres     |
       |                                  +---------------+
       |                                          |
       |                                          v
       |                                  +---------------+
       |                                  | S3-compatible |
       |                                  | object store  |
       |                                  +---------------+
```

- `apps/web` is built to static assets and served by a CDN/static host
  (Cloudflare Pages, Vercel static, S3+CloudFront, Nginx, etc.).
- `apps/api` runs as the origin API server with Fastify + tRPC.
- Postgres is authoritative for promoted projections and Better Auth.
- S3-compatible object storage (or a mounted filesystem in self-host
  mode) is authoritative for CAS / raw / artifact bytes.

Self-host alternative: `apps/api` can also serve `apps/web/dist` behind
the same origin if cross-origin cookies become a deployment problem.
Same-origin deploy reduces CORS complexity but is not required.

## Required environment

### Browser (`apps/web` at build time)

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_PROSA_API_URL` | yes outside dev | Origin of `apps/api`, used by the tRPC client and the Better Auth fetch wrapper. The web bundle refuses to start if this is missing outside development (`apps/web/src/lib/config.ts`). |
| `VITE_PROSA_APP_ENV` | no | `development` \| `preview` \| `production`. Defaults to `development` when `import.meta.env.MODE` is not `production`. |
| `VITE_PROSA_GITHUB_URL` | no | Marketing footer/header link. |
| `VITE_PROSA_MARKETING_DOCS_URL` | no | Marketing "Docs" link target. |

Vite injects all `VITE_*` values into the build; never put secrets in
these. The web bundle never writes session tokens or cookies into
localStorage; the only persisted browser auth state is the HTTP-only
cookie set by Better Auth.

### Local development origins

For local browser testing, keep the web app and API on the same hostname:

```bash
pnpm --filter @c3-oss/prosa-web dev
# open http://localhost:5173
```

In development, `apps/web/src/lib/config.ts` defaults
`VITE_PROSA_API_URL` to `http://localhost:3000`, and the web package dev
script starts Vite with `--host localhost`. Do not mix
`http://localhost:5173` with `http://127.0.0.1:3000`, or
`http://127.0.0.1:5173` with an API CORS allow-list for localhost only:
browser cookies and credentialed CORS treat those as different origins.

If you intentionally serve web from `127.0.0.1`, set both sides
explicitly for that hostname, including `VITE_PROSA_API_URL` and
`PROSA_WEB_ORIGIN`.

### Server (`apps/api`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `PROSA_API_URL` | yes | Public API origin (used by Better Auth `baseURL` and trusted-origin list). |
| `PROSA_DATABASE_URL` | yes in production | Postgres connection string. Refusal to boot in production without one (`apps/api/src/config.ts`). |
| `PROSA_AUTH_SECRET` | yes in production | Better Auth signing secret, ≥16 chars. Production startup refuses fallback secrets. |
| `PROSA_CURSOR_HMAC_SECRET` | yes in production | HMAC-SHA256 key for signing paginated read cursors (Lane 6 / CQ-146). Minimum 32 bytes (UTF-8 chars). Every API worker MUST share the same value so cursors round-trip across the fleet. Production startup refuses to boot when this is missing or too short (`apps/api/src/config.ts`); dev / test boots fall back to a per-process random key. The bundled `docker-compose.yml` requires the operator to supply this via env (`${PROSA_CURSOR_HMAC_SECRET:?...}`) — there is no public fallback. |
| `PROSA_WEB_ORIGIN` | yes for cross-origin web | Comma-separated browser origins that may use credentialed CORS + Better Auth trusted-origin. Each entry must be a valid full origin (`https://console.prosa.dev`) — `apps/api/src/config.ts` enforces this. |
| `PROSA_OBJECT_STORE_DRIVER` | yes in production | `s3` or `fs`. Memory driver is rejected outside test runs. |
| `PROSA_OBJECT_STORE_BUCKET` | s3 only | S3 bucket name. |
| `PROSA_OBJECT_STORE_PREFIX` | yes (defaults `prosa/`) | Prefix for canonical and artifact storage keys. |
| `PROSA_OBJECT_STORE_ENDPOINT` / `REGION` / `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` | s3 only | S3 SDK configuration. |
| `PROSA_OBJECT_STORE_ROOT` | fs only | Local filesystem root for the `fs` driver. |
| `PROSA_API_HOST` / `PROSA_API_PORT` | no | Bind host/port; default `127.0.0.1:3000`. For local browser flows, advertise and call the API as `http://localhost:3000` unless you also switch the web origin to `127.0.0.1`. |
| `PROSA_LOG_LEVEL` | no | pino level; default `info`. |

The fail-closed startup invariants live in
`apps/api/src/config.ts`:

- Production without `PROSA_AUTH_SECRET` is refused.
- Production without `PROSA_DATABASE_URL` is refused.
- Production with `PROSA_OBJECT_STORE_DRIVER=memory` is refused.
- Production without a ≥32-byte `PROSA_CURSOR_HMAC_SECRET` is refused
  (CQ-146). The bundled `docker-compose.yml` propagates the same
  fail-closed contract: `docker compose up` and `docker compose config`
  abort when `PROSA_AUTH_SECRET` or `PROSA_CURSOR_HMAC_SECRET` is
  missing from the operator's env or `.env` file. Workers behind a
  load balancer MUST share the same `PROSA_CURSOR_HMAC_SECRET` value
  so a cursor minted on worker A verifies on worker B.

## CORS and Better Auth trusted origins

The Fastify app registers `@fastify/cors` with:

- `credentials: true`
- An explicit allow-list of origins drawn from `PROSA_API_URL` and the
  comma-separated `PROSA_WEB_ORIGIN`.
- Methods limited to GET, POST, OPTIONS.
- Headers limited to `content-type`, `authorization`, `x-prosa-tenant-id`,
  `x-prosa-device-id`.

Origins outside the allow-list receive no `Access-Control-Allow-Origin`
header. Better Auth's `trustedOrigins` list mirrors the same set so the
sign-up / sign-in cookie flow accepts the configured browser origins.
This is verified by `apps/api/test/web-auth.test.ts`.

## Cookie policy

Better Auth issues the session token as an HTTP-only cookie. In
production the API must be served over HTTPS and behind a reverse proxy
that preserves the `Host` header so Better Auth can compute the cookie
domain correctly. The web bundle does not read or write cookies
directly; the only client-side persistence is the React Query cache for
non-secret server state.

If the API and web are on different sites, set
`PROSA_WEB_ORIGIN=https://console.prosa.dev` (etc.) and verify
`SameSite=None; Secure` cookies are issued. Same-origin deploys (web
behind the same domain as the API) avoid cross-site cookie tradeoffs.

## Observability

API logs:

- Structured request logs via pino include request id, route/path,
  status, and latency.
- tRPC errors are logged server-side (`onError` hook in
  `apps/api/src/app.ts`) and normalised before they reach the browser.
- Object access reads are gated by the projection-manifest verification
  and never log raw object bytes or storage keys.

Frontend errors:

- The web bundle wraps the app in `WebErrorBoundary`
  (`apps/web/src/app/error-boundary.tsx`) so an uncaught render exception
  shows a recovery panel instead of a blank page.
- All read errors flow through the page-level `EmptyState` with the
  normalised error message, so 401/403/network errors are visible
  without crashing the route.

## Release gates

The web E2E command introduced by this lane is
`pnpm --filter @c3-oss/prosa-web e2e`. It launches a Playwright spec
that:

- Starts the Vite dev server.
- Loads `/` and asserts the marketing hero renders without contacting
  the API.
- Loads `/login` and asserts the form is reachable from the marketing
  header.

E2E flows that need a populated tenant (signup → console → sessions →
detail → search → analytics → logout) require Postgres + S3-compatible
object storage and are exercised manually with the existing
`just e2e-up` harness; turning that into a fully automated Playwright
suite is the next deployment-readiness milestone.

## Manual smoke checklist

Before promoting a build to production:

- [ ] `pnpm --filter @c3-oss/prosa-web typecheck` green.
- [ ] `pnpm --filter @c3-oss/prosa-web build` green; bundle size
      reviewed against the lane-08 baseline.
- [ ] `pnpm --filter @c3-oss/prosa-web test` green.
- [ ] `pnpm --filter @c3-oss/prosa-web lint` green.
- [ ] `pnpm --filter @c3-oss/prosa-api test` green (includes CORS +
      tenant isolation + verified-projection gating).
- [ ] `pnpm --filter @c3-oss/prosa-web e2e` green.
- [ ] `just e2e-up` + `just e2e` + `just e2e-cli` + `just e2e-down`
      against a disposable Postgres/MinIO stack.
- [ ] `pnpm audit --audit-level moderate` reviewed; runtime / production
      / dev tooling / transitive findings classified.
