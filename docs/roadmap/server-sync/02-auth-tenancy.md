# Server sync lane 2: Auth and tenancy

This lane adds authentication, tenant creation, membership, and invite flows.
The API is tenant-aware from the first protected procedure.

## Goals

- Support email/password signup and login.
- Support CLI login through OAuth Device Authorization.
- Support bearer tokens for non-browser API calls from the CLI.
- Model a tenant as a Better Auth organization.
- Create the first tenant and first admin user during signup.
- Let admins invite more users through links.

## Auth stack

Use Better Auth with these plugins:

- `organization()` for tenants, members, roles, and invitations.
- `deviceAuthorization()` for terminal login.
- `bearer()` for CLI API calls using `Authorization: Bearer <token>`.

Use the Drizzle adapter against Postgres. Generate or hand-maintain the Better
Auth tables in the same migration flow as the Prosa server tables. If the Better
Auth generated schema does not match project naming conventions, keep a thin
mapping layer instead of forking auth behavior.

## Tenant model

The server vocabulary should use `tenant`, but the auth backing model is an
organization:

- `tenant_id` maps to Better Auth `organization.id`.
- The creator is assigned role `admin`.
- Future roles are `admin` and `member`.
- A user can belong to multiple tenants.
- API calls must specify or resolve one active tenant.

Signup must be exposed as one cohesive server flow:

1. Create the user.
2. Create the tenant organization.
3. Add the user as the first admin.
4. Return a login/session response compatible with CLI auth.

If any step fails, the flow must leave no half-created tenant visible to normal
queries.

## tRPC context

Every request context resolves:

- `session`: Better Auth session, or `null`.
- `user`: authenticated user, or `null`.
- `tenantId`: requested active tenant, or `null`.
- `memberRole`: role for `tenantId`, or `null`.
- `isAdmin`: derived from `memberRole`.

Tenant selection precedence:

1. Explicit tRPC input field `tenantId`.
2. Header `x-prosa-tenant-id`.
3. Active organization from Better Auth session.
4. Error if the procedure requires a tenant.

Protected procedures:

- `protectedProcedure`: requires a valid user.
- `tenantProcedure`: requires user membership in the tenant.
- `adminTenantProcedure`: requires admin role in the tenant.

## Public and protected procedures

Public:

- `auth.signupWithTenant`
- `auth.deviceCode`
- `auth.deviceToken`
- `auth.acceptInviteInfo`

Protected:

- `auth.me`
- `tenant.list`
- `tenant.setActive`
- `tenant.get`

Admin-only:

- `tenant.invite`
- `tenant.cancelInvite`
- `tenant.listInvites`
- `tenant.updateMemberRole`
- `tenant.removeMember`

The Better Auth REST endpoints may remain mounted for built-in flows, but the
CLI should use project-owned tRPC wrappers where that keeps output and errors
stable.

## Security rules

- All sync and query rows are scoped by `tenant_id`.
- Every protected mutation logs `user_id`, `tenant_id`, and request id.
- Invite links must expire.
- Tokens are never written to logs.
- Use Postgres Row Level Security where practical, but do not rely on it as the
  only tenant boundary. Application queries must still filter by tenant.

## Acceptance criteria

- Signup creates exactly one tenant and one admin member.
- Non-members cannot read or write tenant data.
- Members cannot invite users.
- Admin invites can be accepted by another user.
- Device login returns a bearer token usable against a protected tRPC procedure.

