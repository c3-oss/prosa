# Server sync

`prosa` runs locally by default. A local bundle is the source of truth for
imported sessions, CAS objects, and the canonical projection — its layout is
described in [`architecture/bundle-format.md`](./bundle-format.md), and the
import pipeline that fills it lives in
[`architecture/import-pipeline.md`](./import-pipeline.md).

A bundle can be promoted to a remote `prosa` API server. Promotion is
one-way: the server is a destination, never a peer. After a successful
verification, the server holds the canonical projection and the CAS bytes
for that store, and subsequent read commands talk to the server's tenant
instead of the local bundle.

## Workspace packages

| Package | Responsibility |
|---|---|
| `apps/api` | Fastify host that mounts Better Auth at `/api/auth/*`, the object I/O routes at `/objects/:objectId`, and tRPC at `/trpc`. |
| `apps/cli` | `prosa` CLI: bundle commands, `prosa auth ...`, `prosa v1 sync ...`. |
| `packages/prosa-db` | Drizzle ORM schema for Postgres: Better Auth tables, server-owned sync state, CAS metadata, canonical projection mirror, search support. |
| `packages/prosa-storage` | `RemoteObjectStore` interface with `memory`, `fs`, and `s3` adapters; CAS-keyed path helpers and verification helpers. |
| `packages/prosa-sync` | Zod schemas, TypeScript types, and the constant `PROTOCOL_VERSION` for the promotion protocol shared by CLI and API. |

## Authentication and tenancy

The API embeds [Better Auth](https://better-auth.com) configured with the
`organization`, `deviceAuthorization`, and `bearer` plugins. Auth requests
flow through the Fastify catch-all at `/api/auth/*` (see
`apps/api/src/app.ts`), which forwards them to the Better Auth handler.
Better Auth's models are wired to the Drizzle tables in
`packages/prosa-db/src/schema/auth.ts`: `user`, `session`, `account`,
`verification`, `organization`, `member`, `invitation`, `device_code`,
`jwks`.

Each Better Auth organization is a `prosa` tenant. Signup creates the user,
the organization, and the founding `member` row, then signs the user in.
Browsers carry cookie sessions; the CLI carries a bearer token. CLI logins
go through email + password (`prosa auth login`) or the OAuth 2.0 device
authorization flow (`prosa auth device-login`).

Every tRPC request runs through `buildCreateContext`
(`apps/api/src/trpc/context.ts`), which resolves:

- `session` and `user` from Better Auth's `getSession`.
- A tenant candidate from `x-prosa-tenant-id` or the session's
  `activeOrganizationId`.
- `memberRole` by querying the `member` table for that `(tenantId, userId)`;
  on a miss, `tenantId` stays `null`.
- `isAdmin` when the resolved role is `admin` or `owner`.

`tenantProcedure` rejects requests without both `tenantId` and `memberRole`
(`apps/api/src/trpc/init.ts`). `adminTenantProcedure` additionally requires
`admin` or `owner`. The same membership check guards the HTTP object routes
in `apps/api/src/http/objects.ts` — the `x-prosa-tenant-id` header is never
trusted on its own.

Rate limits exist at two layers: Better Auth's plugin (sign-in / sign-up /
device endpoints) and an in-process bucket inside the tRPC middleware
(`rateLimitedProcedure` in `init.ts`).

## Storage split

Two stores back the server:

- **Postgres** (`PROSA_DATABASE_URL`) holds all metadata, projection rows,
  auth state, sync bookkeeping, and search documents.
- **Object store** (`PROSA_OBJECT_STORE_*`) holds the actual bytes: CAS
  payloads, raw source files, artifacts, and exports.

### Postgres schema groups

Defined in `packages/prosa-db/src/schema/`:

- **Auth (`schema/auth.ts`)** — Better Auth tables, plus `device_code` and
  `jwks` for the device flow and signed-session keys.
- **Sync bookkeeping (`schema/sync.ts`)** — `device`, `sync_batch`,
  `sync_batch_object_manifest`, `sync_batch_projection_manifest`,
  `sync_source`, `remote_authority`. These describe who uploaded what,
  which batch is in which state, and which store paths have been
  promoted for a tenant.
- **CAS metadata (`schema/objects.ts`)** — `remote_object` (one row per
  object_id with hash, sizes, compression, and storage key) and
  `tenant_object` (per-tenant access grants and refcounts).
- **Canonical projection mirror (`schema/projection.ts`)** —
  `source_file`, `import_batch`, `raw_record`, `project`,
  `projection_session`, `projection_turn`, `projection_event`,
  `projection_message`, `projection_content_block`, `projection_tool_call`,
  `projection_tool_result`, `projection_artifact`, `projection_edge`.
  All rows are keyed on `(tenant_id, id)`.
- **Search (`schema/projection.ts`)** — `search_doc` rows partitioned by
  `tenant_id`.

### Object store

`packages/prosa-storage` defines the `RemoteObjectStore` interface
(`head` / `putIfAbsent` / `get` / `delete`) and three adapters:
`MemoryObjectStore`, `FsObjectStore`, and `S3ObjectStore`. CAS objects use
the same fanout layout as the local bundle:
`<prefix>/objects/blake3/<aa>/<bb>/<hash>.zst`.

`PROSA_RUNTIME_MODE=production` refuses to boot with the `memory` driver
and requires `PROSA_AUTH_SECRET` plus `PROSA_DATABASE_URL`.

## Promotion protocol

Defined in `packages/prosa-sync/src/schemas.ts` with `PROTOCOL_VERSION = 1`.
Each step is a tRPC mutation under `sync.*` except the byte upload, which is
a raw HTTP `PUT`.

1. **`sync.handshake`** — CLI announces version, device name, platform, and
   the bundle store path. The server upserts a `device` row scoped to
   `(tenantId, userId)`, returns its id, echoes negotiated limits, and
   reports whether the store path is already promoted.
2. **`sync.planUpload`** — CLI sends an object manifest (objectId, canonical
   `hash`, `transportHash`, compression, sizes, optional content type) per
   object it intends to upload. The server creates a `sync_batch` in
   `status=open`, writes one `sync_batch_object_manifest` row per object,
   and returns the `batchId`, the `missingObjectIds` it actually wants
   bytes for, and the upload URL template (`/objects/:objectId`).
3. **`PUT /objects/:objectId?batchId=...&hash=...&size=...&uncompressed=...&compression=...&transportHash=...`**
   — body is `application/octet-stream`. The route verifies that the object
   is declared by an open batch belonging to the caller, that body size and
   transport BLAKE3 hash match, that the decompressed bytes match the
   declared canonical hash, and that any existing `remote_object` catalog
   row is compatible. On success it calls `objectStore.putIfAbsent` and
   inserts a `remote_object` row. If catalog insertion fails after a fresh
   PUT, the bytes are best-effort deleted to avoid leaking storage.
4. **`sync.commitUpload`** — CLI sends the same object manifest plus a
   `projection` payload (`sourceFiles`, `rawRecords`, `sessions`,
   `searchDocs`). The server confirms all CAS bytes are present, upserts the
   per-tenant projection rows (`schema/projection.ts`), grants
   `tenant_object` access, writes `sync_batch_projection_manifest` entries
   per `(entityType, entityId)`, and transitions the batch to
   `status=committed`.
5. **`sync.verifyPromotion`** — CLI declares the object ids, source-file
   ids, raw-record ids, session ids, and search-doc ids it expects the
   server to acknowledge (each list capped at 10 000). The server counts
   how many of each declared id is backed by a verified row for the
   tenant, transitions the batch to `status=verified`, and writes a
   `remote_authority` row pinning `(tenantId, storePath)` to the receipt.
   The signed-shape receipt records batch counts, declared-vs-verified
   counts, `cleanupEligible`, and `verifiedAt`.
6. **`sync.ackCleanup`** (optional) — CLI reports which local paths it
   removed; the server stamps `cleanup_acknowledged_at` and
   `remote_authority.cleanup_completed_at`. Failures here are non-fatal
   for the CLI.

`sync.status` returns the `remote_authority` rows for the active tenant, or
the row for a specific `storePath`.

## CLI surface

Config lives at `${XDG_CONFIG_HOME:-~/.config}/prosa/config.json` (override
with `PROSA_CONFIG_PATH`). The file is written `0600`; insecure modes are
repaired on load.

`prosa auth`:

- `signup --email --password --name --tenant [--tenant-slug] [--server]`
- `login --email --password [--server]`
- `device-login [--client-id] [--poll-max-seconds] [--server]`
- `logout [--all]`
- `status [--json]`
- `tenants [--json]`
- `use <tenant-id-or-slug>`

`prosa v1 sync` promotes the bundle at `--store` to the active server / tenant.
Flags:

- `--server <url>` / `--tenant <id-or-slug>` — override the active entry.
- `--store <path>` — bundle directory (defaults to `~/.prosa`).
- `--dry-run` — print upload counts without touching the server.
- `--keep-local` — mark the store remote-authoritative but skip cleanup.
- `--purge-bundle` — additionally remove `objects/`, `raw/`, `prosa.sqlite`,
  and `manifest.json` after verification.
- `--json` / `--verbose` — output controls.
- `--config <path>` — override the config file.

`prosa v1 sync status` prints whether the local bundle still exists and which
promotion receipts are recorded.

## Remote-authoritative reads

After `prosa v1 sync` succeeds, the CLI stores the promotion receipt under
the server entry's `promotions[storePath]`. `resolveReadAuthorityOrFailClosed`
(`apps/cli/src/cli/auth/routing.ts`) decides per command whether reads go
remote or local:

- If the store has no promotion receipt, reads stay local.
- If a receipt exists and the command sets `remoteSupported: true`
  (`prosa v1 sessions list`, `prosa v1 sessions show`, `prosa v1 search`), reads go
  to the server's tenant via tRPC (`sessions.*`, `search.query`).
- If a receipt exists and the command sets `remoteSupported: false`
  (`prosa v1 export`, `prosa v1 analytics`, `prosa v1 query duckdb`, `prosa v1 tui`,
  `prosa v1 mcp`), the command fails closed and asks the caller to use
  `--local` explicitly.
- `--local` reads the local bundle and prints a stale-data warning when
  the store has been promoted.

## Operations

### Schema management

`packages/prosa-db` ships Drizzle migrations. `applySchema(raw)` runs on API
startup as a safety net of idempotent `CREATE ... IF NOT EXISTS` statements
and then verifies that the required tables exist (`user`, `session`,
`organization`, `member`, `device`, `sync_batch`, `remote_object`,
`tenant_object`, `projection_session`, `search_doc`). A missing table
aborts startup.

### Environment

- `PROSA_API_URL`, `PROSA_API_HOST`, `PROSA_API_PORT`, `PROSA_LOG_LEVEL`,
  `PROSA_RUNTIME_MODE` — Fastify and runtime selection.
- `PROSA_DATABASE_URL` — Postgres connection string (required outside test).
- `PROSA_AUTH_SECRET` — Better Auth secret (>= 16 chars; required in
  production).
- `PROSA_CURSOR_HMAC_SECRET` — HMAC key used to sign paginated read
  cursors (CQ-142 / CQ-146). Minimum 32 characters. **Production
  refuses to boot without it.** The same secret must be configured
  on every worker / instance so cursors round-trip across the fleet
  — a per-process random fallback only happens in `development` and
  `test` runs.
- `PROSA_OBJECT_STORE_DRIVER` — `s3` | `fs` | `memory` (memory is
  test-only).
- `PROSA_OBJECT_STORE_BUCKET`, `PROSA_OBJECT_STORE_PREFIX`,
  `PROSA_OBJECT_STORE_ENDPOINT`, `PROSA_OBJECT_STORE_REGION`,
  `PROSA_OBJECT_STORE_ACCESS_KEY_ID`,
  `PROSA_OBJECT_STORE_SECRET_ACCESS_KEY` — S3 driver.
- `PROSA_OBJECT_STORE_ROOT` — required for the filesystem driver.

### Docker harness

The local end-to-end stack is driven by recipes in `.justfile`:

- `just docker-up` / `just docker-down` / `just docker-logs` — start, stop,
  and tail the full local server stack (API, Postgres, MinIO) defined by
  `docker-compose.yml`.
- `just dev-api` — run the API server through SWC against local services.
- `just e2e-up` / `just e2e-down` — start and stop the Postgres + MinIO
  stack used by the E2E suites (`apps/api/docker-compose.test.yml`).
- `just e2e` — run the API E2E suite against the harness.
- `just e2e-cli` — run the CLI two-device E2E suite against the same
  harness.

## Where to look first

| Task | Entry point |
|---|---|
| Add a Drizzle table or migration | `packages/prosa-db/src/schema/` |
| Change auth wiring or plugins | `apps/api/src/auth.ts` |
| Resolve session, tenant, or admin in tRPC | `apps/api/src/trpc/context.ts`, `apps/api/src/trpc/init.ts` |
| Change the promotion protocol shape | `packages/prosa-sync/src/schemas.ts` |
| Change a server-side sync step | `apps/api/src/trpc/routers/sync/` |
| Add an object-store adapter | `packages/prosa-storage/src/adapters/` |
| Add or fix a CLI auth / sync command | `apps/cli/src/cli/commands/auth.ts`, `apps/cli/src/cli/commands/sync.ts` |
| Route a read command to the server | `apps/cli/src/cli/auth/routing.ts` |
