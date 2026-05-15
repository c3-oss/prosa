# Server sync lane 3: Remote store and file storage

This lane defines how the server stores the contents that currently live inside
`.prosa`. The server must not upload a local bundle directory as-is, and it must
not put every file byte into Postgres.

The product model is local-first until the user authenticates and runs sync. At
that point the local bundle is promoted to remote authority: the server becomes
the canonical store for that tenant, the local `.prosa` data is removed after
verification, and future CLI reads are served by the server.

## Storage decision

Use a split store:

- Postgres stores auth, tenants, devices, upload state, object metadata,
  canonical projection rows, searchable text, reports, and export metadata.
- S3-compatible object storage stores immutable CAS bytes, raw source copies,
  tool outputs, artifacts, and generated exports.
- A filesystem-backed object store is allowed only for local development and
  single-node self-hosting.
- Tantivy and Parquet outputs are derived. They are not authoritative sync
  inputs.

This matches the local bundle design: SQLite catalogs rows and object metadata,
while `objects/blake3/...` stores bytes. The remote equivalent is Postgres plus
object storage.

There is no remote-to-local pull path. A second device does not rebuild a local
`.prosa`; it authenticates, selects the tenant, and asks the server for the same
sessions, search results, analytics, reports, and exports.

## Remote object store contract

Create a shared `RemoteObjectStore` interface:

```ts
export interface RemoteObjectStore {
  head(key: string): Promise<RemoteObjectMeta | null>
  putIfAbsent(key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult>
  get(key: string): Promise<ReadableStream<Uint8Array>>
  delete(key: string): Promise<void>
}
```

Adapters:

- `s3`: production and hosted deployments.
- `fs`: development and self-host single-node.
- `memory`: tests.

Object keys preserve the existing fanout shape:

```text
objects/blake3/<aa>/<bb>/<hash>.zst
raw/sources/<tenant_id>/<source_file_id>.zst
artifacts/<tenant_id>/<artifact_id>
exports/parquet/<tenant_id>/<snapshot_id>/
```

For CAS objects, the key is fully derived from the BLAKE3 hash. Tenant-specific
provenance lives in Postgres, not in the object key.

## Postgres schema groups

Auth and tenancy:

- Better Auth user/session/account tables.
- Better Auth organization/member/invitation tables.

Server ownership:

- `devices`: one row per logged-in CLI installation.
- `sync_batches`: one-way upload lifecycle, status, counts, cleanup receipt,
  and error metadata.
- `sync_sources`: per tenant/device/source upload high-water marks and source
  provenance.
- `remote_authorities`: records that a local store path was promoted to a
  remote tenant and should be queried remotely by default.

CAS metadata:

- `objects`: global by `object_id`, with hash, compression, size, storage key,
  and creation timestamp.
- `tenant_objects`: `tenant_id`, `object_id`, first seen batch, and reference
  counts or provenance markers.

Canonical projection:

- Remote equivalents of `source_files`, `raw_records`, `projects`, `sessions`,
  `turns`, `events`, `messages`, `content_blocks`, `tool_calls`,
  `tool_results`, `artifacts`, and `edges`.
- Every tenant-owned table includes `tenant_id`.
- IDs remain deterministic where local Prosa already has deterministic IDs.

Search:

- `search_docs` with `tenant_id`.
- Postgres FTS indexes for v1 remote search.
- Tantivy sidecar only after the Postgres search path is proven insufficient.

## What not to store as authoritative data

Do not store these as primary sync state:

- `prosa.sqlite`
- `manifest.json`
- local `search/tantivy/`
- local `parquet/`
- local `exports/`

The server can record local bundle metadata for diagnostics, but it must rebuild
canonical remote state from synced rows and CAS objects.

## Local cleanup after promotion

After a successful upload, the CLI verifies that the server can answer core
queries for the promoted bundle. Only then does it remove local bundle data:

- `prosa.sqlite`
- `objects/`
- `raw/`
- `search/`
- `parquet/`
- `exports/`
- `manifest.json`

The CLI stores only non-data authority metadata under the user config directory,
not under `.prosa`: server URL, tenant id, device id, auth state, promotion
timestamp, and the former store path.

If cleanup fails, the server remains authoritative, but the CLI reports the
leftover local path and repeats cleanup on the next command. The leftover bundle
must not be used for reads once promotion has completed.

## Consistency and idempotency

CAS upload order:

1. Client asks `planPush` which object IDs are missing.
2. Client uploads missing bytes through object routes.
3. Server writes or confirms `objects` metadata.
4. Client commits projection rows in `commitBatch`.

If the client crashes after object upload but before `commitBatch`, the object
is harmless. A later sync can attach tenant provenance. A background cleanup job
may delete objects with no `tenant_objects` reference after a retention window.

Promotion completion order:

1. Upload missing CAS bytes.
2. Commit projection rows and provenance.
3. Server rebuilds or marks derived read surfaces ready.
4. CLI calls a verification procedure for counts and sample queries.
5. Server records the local store as promoted.
6. CLI removes the local `.prosa` data.

Use conditional writes for S3-compatible storage when available. On duplicate
object conflicts, compare BLAKE3, uncompressed size, compressed size, and
compression before accepting the object as already present.

## Acceptance criteria

- Two tenants can reference the same CAS object without duplicating bytes.
- A tenant cannot discover another tenant's provenance for a shared object.
- Replaying the same sync batch does not create duplicate projection rows.
- Losing derived exports or search sidecars does not lose canonical data.
- Local development works with the filesystem adapter and the same metadata
  schema.
- After promotion, CLI reads do not use leftover local bundle files.
