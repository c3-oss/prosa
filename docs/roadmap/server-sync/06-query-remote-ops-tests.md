# Server sync lane 6: Server-side reads, operations, and tests

This lane makes promoted data useful from anywhere and defines the operational
checks required before the feature is considered complete.

## Goals

- Make remote reads the default after a verified sync.
- Return the same information the local bundle commands would have returned.
- Run reports, views, analytics, and exports on the server after promotion.
- Add operational controls for migrations, backups, limits, and observability.
- Cover the two-device remote query path without any pull step.

## Command behavior after promotion

After a store is promoted, these commands use the server for the active tenant:

- `prosa sessions`
- `prosa search <query>`
- `prosa query <expr>`
- `prosa analytics ...`
- `prosa export ...`
- `prosa mcp`
- `prosa tui`

Default behavior:

- Before auth/sync, commands remain local-first and read `.prosa`.
- After auth/sync, commands are remote-authoritative and do not read `.prosa`.
- `--tenant <id-or-slug>` overrides the active tenant.
- `--json` uses stable machine-readable output.
- Remote errors use the same CLI user-error handling path as local commands.

There is no `--remote` flag requirement for normal use after promotion. The
authority routing comes from login, active tenant, and promotion receipt.

## Server procedures

Read procedures:

- `sessions.list`
- `sessions.get`
- `search.query`
- `query.run`
- `analytics.summary`
- `analytics.toolUsage`
- `analytics.modelUsage`
- `analytics.projectActivity`

Export procedures:

- `export.markdown`
- `export.parquetSnapshot`
- `export.status`
- `export.downloadUrl`

The v1 server search path uses Postgres-backed `search_docs`. Tantivy is a
future optimization and must remain rebuildable. Parquet snapshots are generated
on the server from canonical Postgres rows and stored as export artifacts in the
object store.

## Operations

Migrations:

- Drizzle migrations are checked into the repo.
- Better Auth schema changes are generated and reviewed before commit.
- Startup should fail fast if required migrations are missing.

Backups:

- Postgres backups cover auth, tenancy, projection rows, report state, export
  metadata, and upload state.
- Object storage backups or versioning cover CAS bytes and generated exports.
- Recovery docs must state that derived Tantivy/Parquet can be rebuilt.

Limits:

- Per-request max JSON payload size.
- Per-object max upload size.
- Per-batch max rows and bytes.
- Per-tenant storage accounting.
- Rate limits on auth, invite, upload, query, and export routes.

Observability:

- Structured logs include request id, user id when authenticated, tenant id
  when selected, device id, procedure path, status, and duration.
- Metrics include upload batches, bytes uploaded, object dedup hits, failed auth
  attempts, search latency, export latency, and stale index count.
- Audit records cover signup, login, invite, role changes, device revocation,
  upload commits, promotion verification, local cleanup receipts, and object
  deletion.

## Test matrix

Unit tests:

- Zod schemas for upload manifests.
- Tenant resolution precedence.
- Role enforcement for protected procedures.
- Authority routing for local vs. server reads.
- Object key derivation and BLAKE3 verification.
- Duplicate object upload handling.

API integration tests:

- Signup creates tenant and first admin.
- Admin invite can be accepted by a second user.
- Member cannot invite users.
- Non-member cannot query tenant data.
- Device token authenticates tRPC and object routes.
- Server search/export procedures return results from promoted rows.

Promotion integration tests:

- Device A promotes a fixture bundle.
- Device A local bundle data is removed after verification.
- Device A search runs remotely after promotion.
- Device B logs in and can search for a session from Device A without pull.
- Re-running sync is idempotent when a promotion receipt already exists.
- Crash after object upload and before batch commit is recoverable.
- Verification failure preserves local `.prosa`.
- Cleanup failure marks remote authority and retries cleanup later.
- Conflicting projection row is rejected and logged.

CLI integration tests:

- `auth login` device flow with mocked polling.
- `auth status --json`.
- `sync --dry-run`.
- `sync --keep-local` still marks remote authority.
- `sync` against a test server removes the temporary bundle after verification.
- `search --json` routes to the server after promotion.
- `export parquet` creates a server-side export and downloads the result.

## Final acceptance gate

Before merging the full feature:

- `pnpm i`
- `just typecheck`
- `just test-all`
- `just lint-all`
- `just build-all`
- API package tests with Postgres test database.
- End-to-end promotion test with two temporary devices and no pull command.
