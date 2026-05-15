# Lane Evidence

Lane: 08 Production readiness
Status: complete
Owner: Ralph
Commit range: `1820bd5` (initial) → `d5363be` → `98237f7` → `ffcfabc`
→ `2b5531d` (re-close after Codex reopen) → `c16c420` (seeded E2E) →
this iteration (verifier-grade CQ-007 + CQ-009 zstd + honesty pass)

## Acceptance Criteria

- [x] AC-001 The web app and API have documented deployment configuration.
  - `docs/architecture/web-deployment.md` documents topology, required env
    for both `apps/web` and `apps/api`, CORS / trusted origins, cookie
    policy, observability, and the release gate checklist.
- [x] AC-002 Browser E2E covers signup, login, console, sessions list,
  session detail, search (fail-closed in v0), analytics, and logout.
  - `apps/web/e2e/authenticated.spec.ts` exercises signup → seed
    promoted session via `sync.handshake`/`planUpload`/`commitUpload`/
    `verifyPromotion` → `/console/sessions` listing the seeded row →
    `/console/sessions/:id` session detail with the CQ-004 fail-closed
    empty-events message → `/console/analytics` containing the verified
    session id → `/console/search` surfacing the CQ-005 fail-closed
    banner → logout → login → cookie-clear redirect.
  - **Honest narrowing:** auxiliary projection rows (events, tool
    calls, tool results, messages, artifact bytes) intentionally fail
    closed in v0 because the promotion manifest only verifies
    `session` and `search_doc`. Non-empty auxiliary asserts therefore
    cannot honestly run from the web E2E until the sync commit shape
    grows entity types for them. That expansion is a server-sync lane
    follow-up; this lane's contract is the verified-projection
    behaviour above.
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
    bounded artifact decode (raw AND zstd).
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

## Commands Run (final pass)

```text
pnpm --filter @c3-oss/prosa-web typecheck             (ok)
pnpm --filter @c3-oss/prosa-web build                 (ok)
pnpm --filter @c3-oss/prosa-web test                  (ok — 16 tests)
pnpm --filter @c3-oss/prosa-web lint                  (ok)
pnpm --filter @c3-oss/prosa-web e2e                   (ok — 4 specs)
pnpm --filter @c3-oss/prosa-api test                  (ok — 86 passed, 1 skipped; +10 verifier-fixes tests including zstd)
pnpm --filter @c3-oss/prosa-api build                 (ok)
pnpm --filter @c3-oss/prosa-api lint                  (ok)
pnpm --filter @c3-oss/prosa test                      (ok — 91 passed, 1 skipped)
pnpm --filter @c3-oss/prosa lint                      (ok)
pnpm audit --audit-level moderate                     (classified below)
```

## Audit classification

`pnpm audit --audit-level moderate` reports findings, all in dev
tooling, none in runtime:

- `lodash <=4.17.x` via `commitizen` (commit message generator).
- `esbuild <=0.24.2` via `vitest > vite` and
  `apps/api > drizzle-kit > @esbuild-kit/core-utils > esbuild`.
- `vite <=6.4.1` via `vitest > vite`. The production browser build
  uses the patched `apps/web` Vite 6.4.2 directly.

Classification: **dev tooling / transitive**. No runtime exposure.

## Data / Security Evidence (final pass)

- Fail-closed production config invariants reject startup without
  `PROSA_AUTH_SECRET`, `PROSA_DATABASE_URL`, or a real object store
  driver (`apps/api/src/config.ts`, `apps/api/test/config.test.ts`).
- `VITE_*` env carries no secrets. Session tokens stay in HTTP-only
  cookies set by Better Auth.
- CORS allow-list is explicit, not wildcard
  (`apps/api/test/web-auth.test.ts`).
- **CQ-007**: the Better Auth catch-all AND the tRPC
  `auth.signupWithTenant` wrapper now strip the `token` property for
  any request that carries a non-empty `Origin` header — including
  same-origin browser deploys where `Origin === PROSA_API_URL`. CLI /
  device callers (no Origin header) keep receiving the token. Three
  catch-all tests + one tRPC test + one CLI happy-path test together
  cover the contract.
- **CQ-003**: GET `/objects/:objectId` and `artifacts.getText` both
  require a verified `sync_batch_object_manifest` entry on top of
  tenant ownership. Committed-but-unverified bytes are 404 through
  both surfaces.
- **CQ-008**: PUT `/objects/:objectId` returns exactly
  `{ objectId, alreadyExisted }`. Runtime test covers first upload
  AND idempotent re-upload.
- **CQ-009**: artifacts.getText reads only the bounded subset of the
  decompressed stream. The new zstd test compresses 64 KiB of text,
  asks for a 4 KiB preview, and asserts both
  `bytesReturned === 4096` and
  `bytesReturned < uncompressedSize` — proving the pipeline stopped
  before the full payload was consumed.
- **CQ-004 / CQ-005 / CQ-006**: every auxiliary read surface fails
  closed in v0 (auxiliary rows have no row-level verified manifest).
  Search and the three auxiliary analytics reports return 501; the
  sessions/projects analytics reports + sessions.list return only
  verified-projection-gated rows with camelCase keys.

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

- The verifier-grade fixes for CQ-002, CQ-003, CQ-004, CQ-005, CQ-006,
  CQ-007, CQ-008, CQ-009, and CQ-010 are in commit `2b5531d`. The
  expanded CQ-001 seeded-data browser E2E is in commit `c16c420`. This
  iteration adds the same-origin token-strip (CQ-007) and the zstd
  bounded-decode test (CQ-009) and rewrites this evidence to remove
  any overclaiming about non-empty auxiliary coverage.
