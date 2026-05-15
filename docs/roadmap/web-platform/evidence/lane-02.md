# Lane Evidence

Lane: 02 Frontend foundation
Status: complete
Owner: Ralph
Commit range: `eb435b6`

## Acceptance Criteria

- [x] AC-001 `apps/web` exists as a private workspace package named
  `@c3-oss/prosa-web` with `private: true` in `apps/web/package.json`.
- [x] AC-002 Vite React SPA builds with strict TypeScript (Vite 6, React 19,
  TanStack Router/Query, TypeScript NodeNext/Bundler).
- [x] AC-003 Route groups cover public, auth, and console placeholders:
  `apps/web/src/routes/marketing`, `apps/web/src/routes/auth`,
  `apps/web/src/routes/console`.
- [x] AC-004 `AppProviders` wires React Query, tRPC client with cookie
  credentials and `x-prosa-tenant-id` candidate header, auth wrapper, and
  router (`apps/web/src/app/providers.tsx`, `apps/web/src/app/router.tsx`).
- [x] AC-005 tRPC client compiles against `AppRouter` from `@c3-oss/prosa-api`
  via workspace dependency (`apps/web/src/lib/api.ts`).
- [x] AC-006 CSS tokens mirror the lane 1 visual direction
  (`apps/web/src/styles/tokens.css`), with separate marketing/console
  stylesheets.
- [x] AC-007 Landing route renders without API availability — covered by the
  `LandingPage` test (`apps/web/src/routes/marketing/landing.test.tsx`) which
  renders without contacting the API.
- [x] AC-008 Console route renders an authenticated-shell placeholder. Real
  auth/tenant guard wiring lives in lane 03 (placeholder uses `EmptyState`
  CLI guidance to avoid faking promoted data).

## Implementation Notes

- Code-based TanStack Router declarations live in
  `apps/web/src/app/router.tsx` to avoid file-based router code generation in
  v0.
- The browser tRPC client uses `httpBatchLink` with `credentials: 'include'`
  and a header callback that reads the active tenant from app context. A
  client-supplied `x-prosa-tenant-id` is only a candidate; the API verifies
  membership server-side (see `apps/api/src/trpc/context.ts`).
- Browser auth wrapper (`apps/web/src/lib/auth.ts`) is intentionally thin: it
  posts to `/api/auth/sign-in/email`, `/api/auth/sign-up/email`, and
  `/api/auth/sign-out` with `credentials: 'include'`. Session tokens stay in
  the HTTP-only cookie set by Better Auth; nothing lands in localStorage.
- Workspace `react`/`react-dom` are pinned via `pnpm-workspace.yaml` overrides
  to keep apps/cli (Ink) and apps/web on the same major/minor/patch and avoid
  the "Incompatible React versions" error.
- `apps/web/tsconfig.json` resolves `@c3-oss/prosa-api` via the package's
  built `dist/index.d.ts` (workspace symlink) so the web compilation does not
  pull the API server source into its program.

## Commands Run

```text
pnpm install                                          (ok)
pnpm --filter @c3-oss/prosa-web typecheck             (ok)
pnpm --filter @c3-oss/prosa-web build                 (ok — dist/ produced)
pnpm --filter @c3-oss/prosa-web test                  (ok — 6 tests passed)
pnpm --filter @c3-oss/prosa-web lint                  (ok)
pnpm --filter @c3-oss/prosa-api typecheck             (ok — no regressions)
pnpm --filter @c3-oss/prosa lint                      (ok — no regressions)
```

## Data / Security Evidence

- Browser-visible env vars are limited to `VITE_PROSA_*` and contain no
  secrets (`apps/web/env.d.ts`, `apps/web/src/lib/config.ts`).
- tRPC and auth fetch calls use `credentials: 'include'`; nothing mirrors
  cookies/tokens into localStorage.
- The active tenant is forwarded as a candidate header
  (`x-prosa-tenant-id`) which the API independently verifies against the
  `member` table.

## Known Risks

- `loadWebConfig` throws when `VITE_PROSA_API_URL` is missing outside dev.
  This is intentional (fail-fast) but means the production build must inject
  it via env at build/serve time. Documented in `apps/web/src/lib/config.ts`.
- Lane 03 must add a real session-hydration query (`auth.me`) and tenant
  selector before any console data routes can read tenant data.

## Reviewer Notes

- Codex review of lane 02: minimal-coherent scaffold is in place. Lane 03
  picks up auth/tenancy wiring; lane 04 fills out the read API surface.
