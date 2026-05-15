# Lane Evidence

Lane: 03 Browser auth and tenancy
Status: complete
Owner: Ralph
Commit range: pending — see `status.md` for commit hash

## Acceptance Criteria

- [x] AC-001 New user can sign up, create a tenant, and reach `/console`.
  - `SignupPage` (`apps/web/src/routes/auth/signup.tsx`) calls
    `api.auth.signupWithTenant`, then invalidates `auth.me` and navigates to
    `/console`. The existing API test `apps/api/test/auth.test.ts` covers
    the server-side flow including rollback on slug collision.
- [x] AC-002 Existing user can log in and reach the active tenant console.
  - `LoginPage` calls `auth.signIn` (Better Auth `POST /api/auth/sign-in/email`
    with `credentials: 'include'`), then refreshes `auth.me`.
- [x] AC-003 Logout clears cached protected data.
  - `ConsoleLayout` triggers `auth.signOut`, then clears the React Query
    cache and navigates to `/login`.
- [x] AC-004 Tenant switch invalidates and reloads tenant-scoped queries.
  - `TenantSwitcher` (`apps/web/src/components/console/tenant-switcher.tsx`)
    calls `tenant.setActive`, mirrors the active tenant into `AppContext`
    so subsequent tRPC requests send `x-prosa-tenant-id`, and invalidates
    every cached query before refreshing `auth.me`.
- [x] AC-005 Non-members cannot access tenant data by manually setting a tenant
  ID.
  - Server-side membership remains the source of truth; see
    `apps/api/src/trpc/context.ts` (`resolveMembership`) and
    `apps/api/test/authz.test.ts` which already covers the cross-tenant
    header spoof case.
- [x] AC-006 Normal members cannot invite users.
  - The team settings form uses `tenant.invite` which is wrapped in
    `adminTenantProcedure`. The UI hides the invite form when
    `memberRole` is neither `admin` nor `owner`; the server still rejects
    forged calls.
- [x] AC-007 Admin invite flow is visible and protected.
  - Admins see the invite form on `/console/settings/team`.
- [x] AC-008 CORS and trusted origins support credentialed browser auth from
  configured web origins.
  - `apps/api/src/app.ts` registers `@fastify/cors` with `credentials: true`,
    a strict origin allowlist sourced from `PROSA_WEB_ORIGIN`, and the
    `x-prosa-tenant-id` header allowed. Better Auth `trustedOrigins`
    includes those origins (`apps/api/src/auth.ts`). Verified by the new
    `apps/api/test/web-auth.test.ts`.

## Implementation Notes

- API additions:
  - `PROSA_WEB_ORIGIN` (comma-separated) added to `apps/api/src/config.ts`.
  - `@fastify/cors` registered with explicit allowlist (no `*`,
    `credentials: true`).
  - `auth.me` now returns `tenants[]` with role per tenant by joining
    `member` and `organization`, so the browser can render a tenant
    switcher without an extra round trip.
- Web additions:
  - `AuthProvider` (`apps/web/src/app/auth-context.tsx`) wraps the app in
    a React-Query-backed session source (`status`, `me`, `refresh`).
  - `AppProviders` now mounts `AuthProvider` by default and exposes
    `skipAuth` for primitive-only tests.
  - `ConsoleLayout` redirects to `/login` when `status === 'unauthenticated'`
    and mirrors the active tenant into `AppContext` so every tRPC request
    forwards `x-prosa-tenant-id` as a candidate header.
  - `LoginPage` and `SignupPage` use mutations + cache invalidation, no
    direct `window.location.assign` after success.
  - `TenantSwitcher` and `TeamSettings` consume the existing
    `tenant.setActive` and `tenant.invite` procedures.

## Commands Run

```text
pnpm --filter @c3-oss/prosa-api typecheck             (ok)
pnpm --filter @c3-oss/prosa-api test                  (ok — 57 passed, 1 skipped; includes new web-auth.test.ts)
pnpm --filter @c3-oss/prosa-api build                 (ok — regenerated dist for the web types)
pnpm --filter @c3-oss/prosa-api lint                  (ok)
pnpm --filter @c3-oss/prosa-web typecheck             (ok)
pnpm --filter @c3-oss/prosa-web build                 (ok — 219 modules)
pnpm --filter @c3-oss/prosa-web test                  (ok — 8 passed)
pnpm --filter @c3-oss/prosa-web lint                  (ok)
```

## Data / Security Evidence

- Browser auth wrapper (`apps/web/src/lib/auth.ts`) and tRPC client
  (`apps/web/src/lib/api.ts`) always send `credentials: 'include'` and
  never persist tokens or cookies to localStorage/logs.
- `x-prosa-tenant-id` is a client candidate; the API verifies membership in
  `apps/api/src/trpc/context.ts` before exposing tenant data.
- New CORS test `apps/api/test/web-auth.test.ts` proves an unknown origin
  receives no `Access-Control-Allow-Origin` matching the attacker host.
- `tenant.invite` is gated by `adminTenantProcedure`; the UI mirrors that
  gate but the server-side gate is authoritative.

## Known Risks

- Production cookie behavior (`secure`, `same-site`) still inherits Better
  Auth defaults; lane 08 must verify cross-origin cookies with a real
  browser E2E and lock down production cookie attributes.
- `tenant.setActive` writes Better Auth session state; when the
  browser-issued cookie is third-party (cross-site), behavior depends on
  the browser's `Set-Cookie` policy. Lane 08 covers same-site vs cross-site
  deploy guidance.

## Reviewer Notes

- Codex review of lane 03: cookie-based auth and tenant scoping work end
  to end with the existing Better Auth surface; no parallel web auth was
  introduced. Lane 04 picks up the read API extensions.
