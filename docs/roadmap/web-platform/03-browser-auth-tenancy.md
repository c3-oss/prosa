# Web platform lane 3: Browser auth and tenancy

This lane makes the browser app usable by real users: signup, login, logout,
session hydration, tenant creation, tenant switching, and basic team settings.
It extends the existing API auth/tenancy model rather than inventing a parallel
web-only auth system.

## Goals

- Use the existing `apps/api` Better Auth installation and tenant model.
- Let a new user sign up, create their first tenant, and enter the console.
- Let an existing user log in, select a tenant, and use protected routes.
- Let admins invite members and view team membership.
- Keep browser auth cookie-based; CLI bearer/device auth remains separate.

## Backend dependencies

Required existing API surfaces:

- `/api/auth/*` Better Auth routes mounted by `apps/api`.
- `auth.signupWithTenant`
- `auth.me`
- `tenant.list`
- `tenant.setActive`
- `tenant.invite`

Backend additions or confirmations:

- CORS allows the web origin and supports credentials.
- Better Auth trusted origins include the web origin.
- `auth.me` returns user, session, active tenant, member role, and available
  tenant metadata or there is a companion endpoint that does.
- Tenant selection validates membership server-side.
- Admin-only tenant procedures reject normal members.

## Browser auth flows

Signup:

- Route: `/signup`.
- Fields: name, email, password, tenant name, optional tenant slug.
- Submit calls `auth.signupWithTenant`.
- On success, hydrate session and route to `/console`.
- If tenant creation fails after user creation, API must not report success.
- UI shows password rules, duplicate email errors, tenant slug errors, and
  rate-limit errors.

Login:

- Route: `/login`.
- Fields: email, password.
- Submit uses Better Auth browser sign-in or a project wrapper around
  `/api/auth/sign-in/email`.
- On success, call `auth.me`.
- If user has one tenant, set it active and route to `/console`.
- If user has multiple tenants and no active tenant, route to tenant picker.

Logout:

- Available in `AccountMenu`.
- Calls Better Auth sign-out.
- Clears React Query cache.
- Routes to `/login`.

Session hydration:

- On app load, call `auth.me`.
- While pending, public routes render immediately; console routes show a shell
  skeleton.
- A 401 clears local auth state and routes protected pages to `/login`.
- A 403 on a tenant-scoped call shows an authorization error and prompts tenant
  switch.

## Tenant flows

Tenant switcher:

- Always visible in the console sidebar.
- Shows active tenant name, role, and sync/data status.
- Lists available tenants from `tenant.list`.
- Calls `tenant.setActive` and invalidates tenant-scoped queries.

Team settings:

- Route: `/console/settings/team`.
- Admins can invite members by email and role.
- Members can view membership but cannot invite or change roles.
- Pending invites show email, role, status, expiration, and inviter.

Deferred but designed:

- Accept-invite public route.
- Password reset.
- Member role updates.
- Member removal.
- Organization rename/logo.

## Components

Auth components:

- `AuthLayout`: split panel with brand proof on one side and form on the other.
- `SignupForm`: validates user and tenant fields before submission.
- `LoginForm`: minimal email/password flow.
- `AuthBrandPanel`: shows CLI quickstart and product proof, not generic art.
- `AuthErrorCallout`: maps normalized auth errors to clear messages.
- `PasswordRules`: inline password policy.

Tenant components:

- `TenantSwitcher`
- `TenantPicker`
- `TenantRequiredState`
- `TeamMembersTable`
- `InviteMemberDialog`
- `RoleBadge`
- `ForbiddenTenantState`

## Layout behavior

Desktop:

- Auth pages use a two-column layout.
- The left visual column contains a terminal/session preview and security copy.
- The form column is narrow and centered.

Mobile:

- Auth pages become single-column.
- Brand proof moves below the form.
- Tenant switcher opens in a bottom sheet.

Console:

- User menu is pinned at the bottom of the sidebar on desktop.
- On mobile, user menu lives in the top drawer.

## Security rules

- Browser uses cookie sessions by default.
- tRPC requests include credentials.
- Tenant ID from the client is only a candidate; API membership checks remain
  authoritative.
- Do not store session tokens in localStorage.
- Do not log passwords, auth headers, cookies, invite links, or session tokens.
- Display only tenant data from verified promoted projections.

## Acceptance criteria

- New user can sign up, create a tenant, and reach `/console`.
- Existing user can log in and reach the active tenant console.
- Logout clears cached protected data.
- Tenant switch invalidates and reloads tenant-scoped queries.
- Non-members cannot access tenant data even if they manually set a tenant ID.
- Normal members cannot invite users.
- Admin invite flow is visible and protected.

