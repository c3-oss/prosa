# Lane 07: Auth, Device, Tenant, And Abuse Controls

Severity: high/medium

## Problem

The current auth and tenant model has the right foundation, but it lacks
hardening against abuse, ambiguous state, and weak operational controls.

Relevant areas:

- public signup;
- public device-code issuance and polling;
- password login;
- tenant invites;
- device identity;
- token storage and revocation;
- membership role resolution;
- audit trail.

## Findings

### Public Signup Can Create Unlimited Tenants

`auth.signupWithTenant` is public. That is appropriate for open signup, but
there is no rate limiting, CAPTCHA/human verification hook, domain policy, or
admin-controlled allowlist.

Impact: storage/database abuse via tenant creation.

### Device Code Endpoints Need Rate Limits

`auth.deviceCode` and `auth.deviceToken` are public. Device flow is intended to
be public, but polling endpoints are classic abuse targets.

Impact: token brute force pressure, database churn, log noise.

### Device Identity Is Weak

Device identity is derived from name/platform/store path through handshake, and
same-name devices are found by `(tenant, user, name)`. There is no stable
client-generated installation id or device secret.

Impact:

- device records can race/duplicate;
- device provenance is weak;
- stolen bearer token can claim sync from an existing device name.

### Membership Resolution Is Underconstrained

`resolveMembership` uses:

```sql
SELECT role FROM member WHERE organization_id = $1 AND user_id = $2 LIMIT 1
```

Without a unique constraint on `(organization_id, user_id)`, duplicate rows can
make role selection ambiguous.

### Signup Rollback Is Manual

`signupWithTenant` signs up the user, then creates organization, then sets it
active, with manual rollback on failures. This is better than ignoring
failures, but not equivalent to a transaction across Better Auth operations and
raw SQL cleanup.

Impact: orphan users/orgs can still occur under unusual failures.

### CLI Token Storage Needs Lifecycle Policy

CLI stores bearer token in config JSON with mode `0600`. That is acceptable as
a baseline, but there is no:

- token expiry display;
- refresh/relogin policy;
- logout remote revocation guarantee;
- keychain integration option;
- warning for insecure existing file permissions.

## Required Changes

### 1. Add Rate Limiting

Add server-side rate limits for:

- signup;
- sign-in;
- device code creation;
- device token polling;
- invite creation;
- object upload;
- sync plan/commit/verify.

Use tenant/user/IP aware keys where possible.

### 2. Harden Device Identity

Introduce a local installation id:

```text
~/.config/prosa/device.json
```

or inside CLI config:

```json
{
  "deviceInstallationId": "...",
  "deviceKey": "..."
}
```

Server should register device by stable id, not display name.

Optional stronger path:

- device generates keypair;
- server stores public key;
- sync requests include signed nonce or request signature.

### 3. Add Device Revocation Semantics

Admin/user should be able to:

- list devices;
- revoke device;
- see last sync time;
- see store paths;
- see cleanup status.

All sync endpoints must reject revoked devices.

### 4. Add Membership Constraints

Add DB unique constraint:

```text
unique (organization_id, user_id)
```

Update role resolution to be deterministic and test duplicate prevention.

### 5. Add Audit Events

Create audit table:

```text
audit_event(
  id,
  tenant_id,
  actor_user_id,
  actor_device_id,
  event_type,
  target_type,
  target_id,
  ip_address,
  user_agent,
  metadata,
  created_at
)
```

Emit events for:

- signup;
- login;
- device code issued/approved;
- sync planned/committed/verified;
- cleanup acknowledged;
- object upload;
- invite created/accepted;
- device revoked.

### 6. Token Lifecycle

Add CLI and server behavior for:

- `auth logout` revokes/invalidates remote session where possible;
- `auth status` shows expiry if available;
- config loader warns or fixes permissions if config file is too open;
- optional keychain storage can be deferred but documented.

## Acceptance Criteria

- Public auth endpoints have rate limits.
- Device code polling cannot be hammered without throttling.
- Device identity is stable across CLI runs and not based only on display name.
- Revoked devices cannot plan, commit, verify, upload objects, or ack cleanup.
- Duplicate membership rows are impossible.
- Audit events exist for sync lifecycle.
- CLI logout revokes remote session or clearly reports if remote revocation
  failed.

## Required Tests

- `apps/api/test/rate-limit.test.ts`
  - signup rate limit;
  - device token polling rate limit;
  - object upload rate limit.

- `apps/api/test/device-revocation.test.ts`
  - revoked device cannot call sync endpoints;
  - revoked device cannot upload batch-bound object.

- `apps/api/test/audit-events.test.ts`
  - sync plan/commit/verify emit audit events.

- `apps/cli/test/cli/auth-token-lifecycle.test.ts`
  - logout clears local token and attempts remote signout;
  - config permission warning/fix.

## Files Likely Touched

- `apps/api/src/auth.ts`
- `apps/api/src/trpc/routers/auth.ts`
- `apps/api/src/trpc/routers/sync.ts`
- `apps/api/src/http/objects.ts`
- `packages/prosa-db/src/migrate.ts`
- `packages/prosa-db/src/schema/*`
- `apps/cli/src/cli/auth/*`
- `apps/cli/src/cli/commands/auth.ts`
- tests.

## Non-Goals

- Do not implement enterprise SSO here.
- Do not require hardware-backed keys.

