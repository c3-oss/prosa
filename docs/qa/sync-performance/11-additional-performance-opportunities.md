# 11 — Additional sync performance opportunities after fact-check

**Tier**: planning note · **Onde**: cliente + servidor · **Impacto estimado**:
alto, mas dependente de benchmark · **Esforço**: S-L por item

## Context

This note captures follow-up ideas found while fact-checking proposals 01-10 on
2026-05-16. It is intentionally separate from the original proposals because
several improvements cut across `planUpload`, `commitUpload`, `verifyPromotion`,
object storage, and CLI observability.

External references checked:

- PostgreSQL `INSERT ... ON CONFLICT ... RETURNING` supports `WITH`, conflict
  actions, `WHERE`, and only returns rows that were actually inserted/updated.
  This matters for safe bulk conflict detection.
  <https://www.postgresql.org/docs/current/sql-insert.html>
- PostgreSQL `jsonb_to_recordset` expands a JSON array of objects into typed
  rows and is a practical alternative to large parallel `unnest(...)` parameter
  lists.
  <https://www.postgresql.org/docs/current/functions-json.html>
- AWS S3 performance guidance recommends horizontal scaling with multiple
  concurrent requests, but does not justify a universal fixed concurrency like
  32 or 128 for every workload.
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html>
- The IETF `Idempotency-Key` draft describes client-generated unique keys and
  forbids reusing a key with a different payload. Prosa still needs its own
  lease/transaction semantics to be crash-safe.
  <https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-01.html>

## P0 — Bulk-ify the whole `planUpload`, not just `findMissingObjectIds`

Proposal 01 correctly targets `findMissingObjectIds`, but `planUpload` still
does per-object `assertRemoteObjectCatalog` and per-object
`sync_batch_object_manifest` inserts before that function runs.

Recommended shape:

- Build an `incoming` relation with `jsonb_to_recordset($1::jsonb)` or typed
  `unnest` arrays.
- Reject duplicate `object_id` values in the input.
- Compare existing `remote_object` rows in one query and fail on metadata drift.
- Insert all `sync_batch_object_manifest` rows with `INSERT ... SELECT`.
- Reuse the same incoming/catalog data to feed missing-object detection.

Tests:

- Existing compatible object.
- Existing divergent object.
- Duplicate object in input.
- Empty input.
- 5k object batch query-count/latency regression.

## P0 — Bulk and parallelize `verifyPromotion`

`verifyPromotion` still performs a serial `tenant_object` lookup and serial
`objectStore.head()` for every object in the batch. If #01 and #04 land, this
can become the next dominant object-checking cost.

Recommended shape:

- Bulk query `tenant_object` with `object_id = ANY($2::text[])`.
- Compare the returned set in memory.
- Run object-store HEADs with bounded concurrency.
- Avoid holding a `FOR UPDATE` transaction open while waiting on object-store I/O
  if the protocol can preserve status safety another way.
- Collapse the six projection count queries into fewer queries over the
  manifest and projection tables.

Tests:

- Missing `tenant_object`.
- Missing object-store blob.
- Hash/size drift.
- Slow object store does not hold DB locks unnecessarily.

## P0 — Make `putIfAbsent` race-safe before increasing concurrency

The S3 adapter does `head()` and then conditional `PutObject`. If another writer
wins between those operations, `PreconditionFailed` should be treated as a
possible idempotent success only after a follow-up `head()` proves compatible
metadata. FS/memory adapters also need explicit same-key race handling if tests
start exercising concurrent object upload.

Recommended shape:

- S3: on conditional put conflict, `head()` and compare hash/size before
  returning `alreadyExisted=true`.
- FS: use exclusive create or a per-key lock; write body and metadata atomically.
- Memory: add an in-flight/per-key guard for deterministic concurrent tests.

Tests:

- Two concurrent identical writes return one fresh write and one already-existed
  result.
- Two concurrent conflicting writes produce a conflict.
- S3 fake/MinIO covers `PreconditionFailed`.

## P1 — Stop reading CAS bytes before the server asks for them

The chunked client reads local object bytes and recomputes transport hashes
before `planUpload`, even for re-syncs where `missingObjects=[]`. That wastes
disk I/O and CPU.

Recommended shape:

- Persist or derive transport metadata in the local object catalog.
- Build the object manifest from catalog metadata first.
- Read bytes only for IDs returned by `planUpload.missingObjectIds`.
- Add an integrity mode or local verification path for detecting corrupted local
  CAS files before upload.

Tests:

- Re-sync with all objects already remote does not open CAS object files.
- Initial sync still reads and uploads missing objects.
- Local corruption is detected before upload or in explicit verification mode.

## P1 — Reduce duplicate buffering and hashing in object upload

The HTTP route verifies transport hash, decompresses to verify canonical hash,
then passes bytes into storage adapters that may buffer and verify again. For
large objects and higher concurrency this multiplies memory pressure.

Recommended shape:

- Short-term: expose a `putPreverified` or equivalent internal storage path used
  only after the HTTP route has verified transport/canonical shape.
- Longer-term: stream request body through transport hashing, decompression, and
  storage write with backpressure.

Tests:

- Invalid transport hash fails before storage.
- Invalid canonical hash fails before catalog insert.
- Large object near `maxObjectBytes` has bounded heap growth.

## P1 — Retry only operations that are already idempotent

Object PUT is content-addressed and a good candidate for retry/backoff after
race-safe `putIfAbsent`. `planUpload` creates a new batch and `commitUpload` is
not retry-safe without #09, so automatic retry there is more dangerous.

Recommended shape:

- Retry object PUT for network errors and HTTP 408/429/5xx.
- Respect `Retry-After`.
- Use exponential backoff with jitter.
- Do not retry 400/403/409/412 blindly.

Tests:

- Fake fetch fails twice then succeeds.
- 429 with `Retry-After` waits.
- 400/403/409/412 are not retried.

## P1 — Fix machine-readable output before adding progress UI

Before adding progress bars, make `--json` reliable. Today verbose human output
can be written to stdout before the final JSON.

Recommended shape:

- `--json`: stdout is exactly one JSON object.
- Human logs/progress go to stderr or are silenced under `--json`.
- `--events-json`: NDJSON event stream, either to stderr/path or explicitly
  incompatible with final JSON-on-stdout.
- Add `--progress auto|always|never`.

Tests:

- `sync --json --verbose` stdout parses as one JSON value or the flag combo is
  rejected.
- `--events-json -` emits parseable NDJSON.
- Non-TTY output has no carriage returns or ANSI escapes.

## P2 — Consider upload tokens if PUT count remains high

Every object PUT resolves session and tenant membership. If individual PUTs
remain after #01/#04/#06, `planUpload` could return a short-lived upload token
scoped to `{tenant,user,batch,expiresAt}`.

This is a security-sensitive optimization and should wait until query/membership
cost is measured.

Tests:

- Tenant spoof rejected.
- Token expired rejected.
- Batch closed rejected.
- Object not declared by batch rejected.

## P2 — Add remote CAS pack blobs if S3 object cardinality dominates

Proposal #07 reduces HTTP request overhead, but still stores one S3 object per
CAS object if the server explodes the bulk request into individual
`putIfAbsent` calls. To reduce millions of physical S3 objects, Prosa needs a
separate physical-location layer: immutable pack blobs plus per-CAS offset
metadata.

Recommended shape:

- Keep logical `object_id = blake3:<hash>` unchanged.
- Add `remote_blob` and `remote_object_location`.
- Pack only small missing CAS objects; keep large objects inline.
- Add `RemoteObjectStore.getRange()` for reads from packed blobs.
- Verify `planUpload`/`commitUpload`/`verifyPromotion` against logical catalog
  rows and HEAD at pack granularity, not per member.

See `12-remote-cas-pack-blobs.md` for the detailed design and risks.
