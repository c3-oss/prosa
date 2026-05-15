# Lane Evidence

Lane: 08 Production readiness
Status: complete
Owner: Ralph

## Acceptance Criteria

- [x] AC-001 The web app and API have documented deployment configuration.
  - `docs/architecture/web-deployment.md` documents topology, required env
    for both `apps/web` and `apps/api`, CORS / trusted origins, cookie
    policy, observability, and the release gate checklist.
- [x] AC-002 Browser E2E covers signup, login, console, sessions list,
  session detail, search (fail-closed in v0), analytics (fail-closed in
  v0), and logout.
  - `apps/web/e2e/authenticated.spec.ts` exercises signup → seed
    promoted session via `sync.handshake`/`planUpload`/`commitUpload`/
    `verifyPromotion` → `/console/sessions` listing the seeded row →
    `/console/sessions/:id` session detail with the fail-closed
    empty-events message → `/console/analytics` surfacing the
    fail-closed error banner (all five `analytics.report` kinds return
    501 in v0) → `/console/search` surfacing the fail-closed banner →
    logout → login → cookie-clear redirect.
  - **Honest narrowing:** auxiliary projection rows (events, tool
    calls, tool results, messages, artifact bytes) intentionally fail
    closed in v0 because the promotion manifest only verifies
    `session` and `search_doc`. Non-empty auxiliary asserts therefore
    cannot honestly run from the web E2E until the sync commit shape
    grows entity types for them. That expansion is a server-sync lane
    follow-up; this lane's contract is the verified-projection
    behaviour above. The `/console/analytics` assertion verifies the
    fail-closed banner only — it does not claim a verified session id
    is rendered in analytics.
- [x] AC-003 Security tests cover tenant isolation and object access.
  - `apps/api/test/authz.test.ts` covers tenant spoofing for every
    tenant procedure including object routes.
    `apps/api/test/web-auth.test.ts` proves the CORS allow-list reflects
    only configured origins.
    `apps/api/test/object-upload-hardening.test.ts` covers cross-tenant
    object reads (and now also requires verified provenance, see CQ-003).
    `apps/api/test/verifier-fixes.test.ts` covers raw object verified-
    provenance, browser-token stripping (including same-origin
    deploys), runtime upload-response shape (no `storageKey`), and
    bounded artifact decode (raw AND zstd, including an instrumented
    chunked-stream proof of bounded source consumption).
- [x] AC-004 Accessibility and performance gates are explicit enough to
  block release.
  - `docs/architecture/web-deployment.md` lists the release checklist
    (typecheck/build/test/lint, browser E2E, API E2E, audit), and lane
    01 stipulates tokenised focus rings + reduced-motion support which
    are encoded in `apps/web/src/styles/global.css` and
    `apps/web/src/styles/tokens.css`. Bundle size is reported by every
    `pnpm --filter @c3-oss/prosa-web build` run for review.
- [x] AC-005 Production readiness is treated as a lane, not an
  afterthought. All previous lanes integrate into the gates documented
  here.

## Implementation Notes

- `apps/web/src/app/error-boundary.tsx` (`WebErrorBoundary`) wraps the
  application root so an uncaught render exception shows a recovery
  panel instead of a blank page. The error message is rendered as text
  in a `<pre>` so even a malformed payload cannot escape into HTML.
- `apps/web/playwright.config.ts` boots a PGlite-backed `apps/api` on
  port 3030 alongside the Vite dev server on port 5174 so the full
  authenticated E2E runs against the real HTTP + cookie stack.
- `apps/web/e2e/marketing.spec.ts` runs a runtime probe that observes
  **zero** `/trpc/*` and `/api/auth/*` requests on first render at `/`.
- `apps/web/e2e/authenticated.spec.ts` drives the public sync API with
  the browser's own cookie session to seed a verified promoted session
  + search_doc, then re-loads the console routes to assert the verified
  contract.
- The release checklist is duplicated in `web-deployment.md` so it is
  visible alongside the env table operators need at deploy time.
- The zstd artifact preview path lives in
  `apps/api/src/trpc/routers/reads/bounded-decode.ts` and uses the
  low-level `DCtx.decompressStream` binding with an output buffer
  sized to the remaining preview budget. The decompressor cannot
  produce more decoded bytes per call than the cap allows.

## Gates Run (this iteration)

The full gate matrix lives in `docs/roadmap/web-platform/gates.md`. The
focused gates run for this correction iteration (covers CQ-011 device-
token regression coverage and the original CQ-001..CQ-010 surface):

```text
git diff --check                                            (ok)
pnpm --filter @c3-oss/prosa-api typecheck                   (ok)
pnpm --filter @c3-oss/prosa-api build                       (ok)
pnpm --filter @c3-oss/prosa-api exec vitest run \
  test/device-auth.test.ts \
  test/verifier-fixes.test.ts \
  test/reads-v0.test.ts \
  test/verified-provenance.test.ts \
  test/correction-fixes.test.ts                             (ok)
pnpm --filter @c3-oss/prosa exec vitest run \
  test/cli/remote-authority.test.ts \
  test/cli/remote-authority-routing.test.ts                 (ok)
pnpm --filter @c3-oss/prosa-web exec playwright test \
  e2e/authenticated.spec.ts e2e/marketing.spec.ts \
  --reporter=list                                            (ok)
```

Classification of the base gate matrix (see `gates.md`):

- `pnpm i` — required, passed.
- `pnpm build` — release-only; per-package builds re-run per-iteration.
- `just typecheck` / `just test-all` / `just lint-all` — release-only
  aggregate gates; per-package equivalents above cover the changed
  surface and are re-run per-iteration.
- `pnpm audit --audit-level moderate` — required, classified
  (dev tooling / transitive, no runtime exposure).
- `git diff --check` — required, passed.
- `just e2e-up` / `just e2e` / `just e2e-cli` / `just e2e-down` —
  **scoped out** for the web-platform roadmap (CQ-012 scope decision).
  Owned by the server-sync lane; the Postgres/MinIO/CLI sync flow is
  unchanged by web-platform work.

## Audit classification

`pnpm audit --audit-level moderate` last reported findings, all in dev
tooling, none in runtime:

- `lodash <=4.17.x` via `commitizen` (commit message generator).
- `esbuild <=0.24.2` via `vitest > vite` and
  `apps/api > drizzle-kit > @esbuild-kit/core-utils > esbuild`.
- `vite <=6.4.1` via `vitest > vite`. The production browser build
  uses the patched `apps/web` Vite 6.4.2 directly.

Classification: **dev tooling / transitive**. No runtime exposure.

## Data / Security Evidence

- Fail-closed production config invariants reject startup without
  `PROSA_AUTH_SECRET`, `PROSA_DATABASE_URL`, or a real object store
  driver (`apps/api/src/config.ts`, `apps/api/test/config.test.ts`).
- `VITE_*` env carries no secrets. Session tokens stay in HTTP-only
  cookies set by Better Auth.
- CORS allow-list is explicit, not wildcard
  (`apps/api/test/web-auth.test.ts`).
- **CQ-007**: the Better Auth catch-all AND the tRPC
  `auth.signupWithTenant` wrapper strip the `token` property for any
  request that carries a non-empty `Origin` header — including
  same-origin browser deploys where `Origin === PROSA_API_URL`. CLI /
  device callers (no Origin header) keep receiving the token.
- **CQ-011**: the device-token flow is CLI/device-only. tRPC
  `auth.deviceToken` returns 403 FORBIDDEN for any non-empty `Origin`
  header (same-origin deploy or configured web origin). The raw
  `/api/auth/device/token` path in the Better Auth catch-all recursively
  strips every bearer-token-bearing field (`token`, `access_token`,
  `refresh_token`, `id_token` and their camelCase variants) for
  browser-origin callers. The no-`Origin` CLI flow continues to receive
  the token after device approval. Four regression tests in
  `apps/api/test/device-auth.test.ts` cover both browser-reject paths,
  the raw-route strip, and the CLI happy path.
- **CQ-003**: GET `/objects/:objectId` and `artifacts.getText` both
  require a verified `sync_batch_object_manifest` entry on top of
  tenant ownership. Committed-but-unverified bytes are 404 through
  both surfaces.
- **CQ-008**: PUT `/objects/:objectId` returns exactly
  `{ objectId, alreadyExisted }`. Runtime test covers first upload
  AND idempotent re-upload.
- **CQ-009**: the zstd preview path uses the low-level
  `DCtx.decompressStream` binding with a destination buffer sized to
  the remaining preview budget; the decompressor cannot emit more
  bytes per call than the cap allows. The instrumented chunked-stream
  test proves both `decodedBytesProduced ≤ maxBytes + 1` and
  `srcBytesConsumed < compressed.byteLength`, so neither the full
  decoded payload nor the full compressed payload is processed before
  slicing.
- **CQ-004 / CQ-005 / CQ-006**: every auxiliary read surface fails
  closed in v0 (auxiliary rows have no row-level verified manifest).
  Search and all five analytics report kinds — `sessions`, `tools`,
  `errors`, `models`, and `projects` — return 501. Only `sessions.list`
  + `sessions.detail` (header) operate over the verified projection,
  and they return verified-projection-gated rows with camelCase keys.

## Known Risks / Follow-ups

- Auxiliary projection rows are still untyped in the promotion
  manifest. The sync commit shape and the manifest must both grow new
  entity types (`event`, `tool_call`, `tool_result`, `message`,
  `artifact`) before non-empty auxiliary E2E coverage is possible.
  Until that lands, the API surfaces and the browser E2E remain
  intentionally fail-closed for those rows.
- Audit findings depend on upstream dev-tool patches and should be
  re-reviewed each release.

## Reviewer Notes

- The shipped analytics contract in v0 is **fail-closed for all five
  report kinds**. Older lane evidence (`lane-04.md`, `lane-07.md`) that
  describes the aspirational "all five reports return rows" behaviour
  is explicitly superseded by CQ-006; the authoritative shipped
  behaviour is documented here.
