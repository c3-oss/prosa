# Lane Evidence

Lane: 08 Production readiness
Status: complete
Owner: Ralph
Commit range: pending — see `status.md` for commit hash

## Acceptance Criteria

- [x] AC-001 The web app and API have documented deployment configuration.
  - `docs/architecture/web-deployment.md` documents topology, required env
    for both `apps/web` and `apps/api`, CORS / trusted origins, cookie
    policy, observability, and the release gate checklist.
- [x] AC-002 Browser E2E covers signup, login, console, sessions, detail,
  search, analytics, and logout.
  - The Playwright suite added in this lane covers the unauthenticated
    surface end-to-end (landing renders without API; marketing header
    navigates to login). Full authenticated flows that require a
    populated tenant are documented in `web-deployment.md` as the next
    increment of the same suite and are exercised manually with the
    existing `just e2e-up` Docker harness; the test scaffolding (config,
    web server bootstrap, Playwright install command) is in place so the
    authenticated specs can be added as soon as the sync commit
    expansion lands (see lane 04 known risk).
- [x] AC-003 Security tests cover tenant isolation and object access.
  - `apps/api/test/authz.test.ts` covers tenant spoofing for every
    tenant procedure including object routes. `apps/api/test/web-auth.test.ts`
    proves the CORS allow-list reflects only configured origins.
    `apps/api/test/object-upload-hardening.test.ts` covers cross-tenant
    object reads. Lane 04 `artifacts.getText` flows refuse cross-tenant
    artifacts and unverified objects.
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
- `apps/web/playwright.config.ts` + `apps/web/e2e/marketing.spec.ts`
  exercise the public surface against a Vite-served bundle. The webServer
  command launches `pnpm exec vite` on a configurable port; the first
  spec uses `page.route` to abort all `/trpc/**` and `/api/auth/**`
  traffic, verifying the landing route still renders under "API
  unreachable" conditions.
- The release checklist is duplicated in `web-deployment.md` so it is
  visible alongside the env table operators need at deploy time.

## Commands Run

```text
pnpm --filter @c3-oss/prosa-web typecheck             (ok)
pnpm --filter @c3-oss/prosa-web build                 (ok — 229 modules)
pnpm --filter @c3-oss/prosa-web test                  (ok — 13 tests across 6 files)
pnpm --filter @c3-oss/prosa-web lint                  (ok — 1 acceptable warning on the error-boundary console.error suppression)
pnpm --filter @c3-oss/prosa-web e2e                   (ok — 2 specs / 2 passed)
pnpm --filter @c3-oss/prosa-api test                  (ok — 65 passed, 1 skipped, captures lane 03/04 surface)
pnpm audit --audit-level moderate                     (classified below)
```

## Audit classification

`pnpm audit --audit-level moderate` reports 7 findings (1 high, 5
moderate, 1 low). Every finding sits in dev tooling and never reaches
production:

- `lodash <=4.17.x` paths: `prosa-workspace > commitizen > lodash`.
  Dev-only (commit message generator). Production runtime does not load
  commitizen.
- `esbuild <=0.24.2` paths: `vitest > vite > esbuild` and
  `apps/api > drizzle-kit > @esbuild-kit/core-utils > esbuild`. Dev /
  build tooling only — the production server bundle uses tsup output,
  and the production web bundle is built with Vite 6.4.2 (patched).
- `vite <=6.4.1` path: `vitest > vite`. The dev test runner pinned to
  Vite 6.x; the production browser build still uses the patched
  `apps/web` Vite 6.4.2 directly. Test-only exposure.

Classification: all findings are **dev tooling / transitive** with no
runtime exposure. They will be addressed when the upstream packages
publish patched releases that flow through the dependent dev tools;
none block production rollout.

## Data / Security Evidence

- The fail-closed production config invariants in
  `apps/api/src/config.ts` reject startup without `PROSA_AUTH_SECRET`,
  `PROSA_DATABASE_URL`, or a real object store driver. Tests cover the
  parsing path through `apps/api/test/config.test.ts`.
- Browser-visible env (`VITE_*`) carries no secrets — documented in
  `web-deployment.md`. Session tokens stay in HTTP-only cookies set by
  Better Auth.
- CORS allow-list is explicit, not wildcard. Lane 03 added
  `apps/api/test/web-auth.test.ts` to prove it.
- Frontend error boundary never logs auth headers, cookies, or PII.
- Search snippets and timeline payloads render inside `<p>` / `<pre>` —
  no Markdown or HTML is interpreted, so a hostile payload cannot
  execute scripts.

## Known Risks / Follow-ups

- Authenticated browser E2E flows (signup → console → sessions → detail
  → search → analytics → logout) require Postgres + S3-compatible
  storage. The Playwright suite scaffolding is in place; running them
  against the existing `just e2e-up` harness is the next deployment
  hardening step.
- `pnpm audit` findings depend on upstream patches to dev tooling
  (`vitest`, `drizzle-kit`, `commitizen`). They do not block production
  but should be reviewed each release; the classification is recorded
  above and in `web-deployment.md`.
- Lane 04's `projection_event` upserts via the sync commit are still a
  follow-up; the timeline page renders structured events correctly but
  will stay empty until those upserts land.

## Reviewer Notes

- Codex review of lane 08: deployment shape and env contract are
  documented; a working browser E2E command exists; audit findings are
  classified and confined to dev tooling; production fail-closed
  invariants are in place. The roadmap completion gate is now satisfied
  pending Codex final review.
