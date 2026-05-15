# Lane 04: Schema, Constraints, And Migrations

Severity: high

## Problem

The server schema currently has two competing sources of truth:

- `packages/prosa-db/src/migrate.ts` contains bootstrap SQL with many composite
  tenant-aware FKs.
- Drizzle schema files in `packages/prosa-db/src/schema/*` model some
  relationships differently, often with global references to `remote_object`.

Startup applies `CREATE TABLE IF NOT EXISTS` and then only checks that key
tables exist. It does not verify required columns, indexes, foreign keys,
deferrable constraints, uniqueness constraints, or schema version.

This creates a dangerous production failure mode: an existing database with old
or partial schema can pass startup checks and then behave differently from tests.

## Concrete Findings

- Drizzle `sourceFile.objectId`, `rawRecord.objectId`, content block object
  refs, tool object refs, and artifact object refs reference global
  `remoteObject.objectId`, while bootstrap SQL uses tenant-scoped composite
  FKs against `tenant_object`.
- `sync_batch.device_id` references `device(id)` globally; application code now
  checks tenant/user/store, but DB constraints do not enforce that relationship.
- `member` lacks an explicit unique constraint on `(organization_id, user_id)`.
  Duplicate member rows can make role resolution ambiguous.
- `device` lacks a unique constraint on `(tenant_id, user_id, name)` or a
  stable client-generated device identity.
- Startup table check would pass if a table exists but is missing critical
  columns like future `transport_hash` or `sync_batch.store_path`.
- Bootstrap SQL contains duplicate index creation for
  `projection_session_source_idx`.

## Attack / Failure Scenarios

### Scenario 1: Schema Drift Weakens Tenant Isolation

1. Production DB was created from older Drizzle migration with global object FK.
2. Runtime bootstrap sees table exists and does not alter it.
3. Application assumes tenant-scoped FK behavior.
4. Cross-tenant object references are accepted by DB.

Impact: data isolation invariant depends on deployment history.

### Scenario 2: Duplicate Membership Ambiguity

1. User has duplicate member rows for same tenant with different roles.
2. `resolveMembership` selects `LIMIT 1` without deterministic ordering.
3. Effective role can vary by planner/storage.

Impact: admin/member authorization can become nondeterministic.

### Scenario 3: Device Race

1. Two handshakes for the same user/device name race.
2. Both observe no row.
3. Both insert separate device ids.

Impact: later device-bound operations become confusing and audit trail splits.

## Required Changes

### 1. Create Versioned Migrations

Add checked-in migration files as the production source of truth.

Example:

```text
packages/prosa-db/migrations/
  0001_auth.sql
  0002_sync_core.sql
  0003_projection.sql
  0004_transport_hash_and_batch_manifest.sql
```

Runtime bootstrap should be only for tests/dev bootstrap or should call the
same migration runner.

### 2. Add Schema Version Table

Add:

```text
prosa_schema_migrations(version, applied_at, checksum)
```

Startup should fail if:

- migrations are missing;
- checksum mismatch;
- database version is older than required;
- database has unknown future version unless explicitly allowed.

### 3. Align Drizzle Schema With SQL

Drizzle definitions must express the same tenant-scoped constraints as SQL, or
at least not contradict them.

If Drizzle cannot express a composite deferrable FK cleanly, document the SQL
constraint in code and add startup verification for it.

### 4. Verify Constraints At Startup

The API should verify:

- required columns;
- required indexes;
- required unique constraints;
- required foreign keys;
- deferrability where relied on;
- schema version.

This is more important than table existence.

### 5. Add Missing Constraints

Recommended:

```text
member unique (organization_id, user_id)
device unique (tenant_id, user_id, name)
sync_batch composite FK (tenant_id, user_id, device_id) -> device(...)
remote_authority FK (tenant_id, device_id) -> device tenant/device relationship
```

If composite FK design gets cumbersome, add explicit unique indexes that make
the constraints possible.

## Acceptance Criteria

- A DB with missing required columns fails startup.
- A DB with old global object FK fails startup or is migrated.
- Drizzle schema and SQL schema no longer disagree on object provenance.
- Duplicate member rows are impossible.
- Duplicate same-name device rows for the same tenant/user are impossible or
  device identity is redesigned.
- Startup verifies schema version and required constraints.

## Required Tests

- `packages/prosa-db/test/migrations.test.ts`
  - fresh migration creates expected schema;
  - repeated migration is idempotent;
  - schema version recorded;
  - constraint checks pass.

- `apps/api/test/schema-verification.test.ts`
  - startup fails when a required column is missing;
  - startup fails when a required FK/index is missing;
  - duplicate member insert fails;
  - duplicate device insert behavior is deterministic.

## Files Likely Touched

- `packages/prosa-db/src/migrate.ts`
- `packages/prosa-db/src/schema/*`
- `packages/prosa-db/migrations/*`
- `apps/api/src/server.ts`
- `apps/api/src/db.ts`
- `apps/api/test/*`
- `packages/prosa-db/test/*`

## Non-Goals

- Do not redesign sync protocol here.
- Do not implement remote read parity here.

