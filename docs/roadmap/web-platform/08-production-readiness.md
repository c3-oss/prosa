# Web platform lane 8: Production readiness

This lane makes the web platform safe to run outside local development. It
covers deployment shape, environment configuration, observability, tests,
accessibility, performance, security, and release gates.

## Goals

- Ship `apps/web` and `apps/api` as a coherent deployable web product.
- Prove browser auth, tenant isolation, read APIs, and console flows end to end.
- Add operational visibility for API and frontend failures.
- Prevent common security regressions around CORS, cookies, object access, and
  tenant spoofing.
- Define release gates for hosted or self-hosted deployment.

## Deployment shape

Recommended v0:

- `apps/web` builds to static assets.
- Static assets are served by a CDN/static host.
- `apps/api` runs as the origin API server.
- Browser talks to `apps/api` through `VITE_PROSA_API_URL`.
- Postgres remains authoritative for remote projections and auth.
- S3-compatible object storage remains authoritative for CAS/raw/artifact bytes.

Alternative self-host shape:

- `apps/api` can serve `apps/web/dist` behind the same origin if needed.
- Same-origin deploy reduces CORS complexity but should not be required.

## Environment variables

Web:

- `VITE_PROSA_API_URL`
- `VITE_PROSA_APP_ENV`
- `VITE_PROSA_GITHUB_URL`
- `VITE_PROSA_MARKETING_DOCS_URL`

API:

- `PROSA_API_URL`
- `PROSA_WEB_ORIGIN`
- `PROSA_DATABASE_URL`
- `PROSA_AUTH_SECRET`
- `PROSA_OBJECT_STORE_DRIVER`
- `PROSA_OBJECT_STORE_BUCKET`
- `PROSA_OBJECT_STORE_PREFIX`
- `PROSA_OBJECT_STORE_ROOT`
- S3 endpoint/region/credentials where applicable.

Rules:

- Production startup fails without real API URL, database URL, auth secret, and
  object-store configuration.
- CORS allows only configured web origins.
- Cookies use production-appropriate secure/same-site settings.
- Logs must not include secrets, auth headers, cookies, object bytes, or invite
  tokens.

## Observability

API:

- Structured request logs include request ID, user ID when available, tenant ID
  when available, route/procedure, status, latency, and error class.
- tRPC errors are normalized for clients and detailed in server logs.
- Object access logs include object ID and tenant ID, not storage key or bytes.
- Add counters for auth failures, rate limits, 403 tenant denials, search
  latency, session-detail latency, and object-preview truncation.

Frontend:

- Central error boundary for public site and console.
- Route-level error panels for recoverable API errors.
- Optional browser error reporting can be added only after privacy policy and
  data scrubbing are defined.

## Testing strategy

Frontend unit/component:

- Primitives render accessible names and focus states.
- Auth forms validate required fields and show normalized errors.
- Sessions table renders loading, empty, error, and data states.
- Timeline renderers handle message, tool call, tool result, artifact, and
  unknown event fixtures.

API integration:

- Authenticated and unauthenticated access.
- Non-member tenant denial.
- Member vs admin permission checks.
- Sessions pagination and filters.
- Session detail timeline joins.
- Search filters and snippets.
- Tool-call filters.
- Analytics reports.
- Artifact/object authorization and truncation.

Browser E2E:

- Signup creates user and tenant.
- Login hydrates session and enters console.
- Empty tenant shows CLI/sync guidance.
- Seeded/promoted tenant shows dashboard and sessions.
- User opens session detail and sees messages/tool calls/results.
- User searches and opens a matching session.
- User opens analytics report.
- User logs out and protected routes redirect.

Use Playwright for E2E once browser flows exist.

## Accessibility gates

- Keyboard navigation works for auth forms, sidebar, filters, tables, timeline,
  dialogs, drawers, and inspector.
- Focus rings are visible and tokenized.
- Dialogs and drawers trap focus.
- Color is not the only status indicator.
- Reduced motion is respected.
- Tables/cards expose meaningful labels on mobile.
- Basic screen-reader smoke tests cover login, session table, and session
  detail.

## Performance gates

- Landing page renders without requiring API calls.
- Console shell avoids blocking on heavy analytics.
- Session table uses server pagination.
- Timeline avoids rendering full large outputs inline.
- Long sessions use incremental loading and virtualization if needed.
- Search input is debounced and cancelable.
- Bundle size is reviewed before adding charting/editor dependencies.

## Security gates

- Tenant ID spoofing tests pass for every read endpoint.
- Artifact/object reads require verified tenant ownership.
- CORS credential mode is configured intentionally.
- Session cookies are not mirrored into localStorage.
- Markdown rendering is sanitized.
- JSON/tool output rendering does not execute HTML.
- Rate limits exist for auth and expensive read endpoints.
- Production API refuses static fallback auth secrets.

## Release checklist

- `pnpm --filter @c3-oss/prosa-web typecheck`
- `pnpm --filter @c3-oss/prosa-web build`
- `pnpm --filter @c3-oss/prosa-web test`
- `pnpm --filter @c3-oss/prosa-api test`
- `pnpm typecheck`
- `pnpm lint`
- Browser E2E suite against API + Postgres + object store.
- Manual responsive pass for desktop and mobile.
- Manual auth/tenant isolation smoke test.

## Acceptance criteria

- The web app and API have documented deployment configuration.
- Browser E2E covers signup, login, console, sessions, detail, search,
  analytics, and logout.
- Security tests cover tenant isolation and object access.
- Accessibility and performance gates are explicit enough to block release.
- Production readiness is treated as a lane, not an afterthought after UI work.

