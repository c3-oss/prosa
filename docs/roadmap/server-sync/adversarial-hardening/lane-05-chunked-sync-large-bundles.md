# Lane 05: Chunked Sync And Large Bundle Safety

Severity: high

## Problem

The previous `LIMIT 5000` truncation was removed from the CLI upload readers.
That fixed silent partial uploads, but it exposed the next issue: the protocol
still has `maxRowsPerCommit = 10_000` and no chunking.

Large `.prosa` bundles can easily exceed 10k rows across:

- source files;
- raw records;
- sessions;
- search docs;
- future turns/messages/tool calls/artifacts.

Current behavior for large bundles is likely:

1. CLI reads the entire local bundle into memory.
2. CLI uploads CAS objects.
3. `commitUpload` rejects because row count exceeds `maxRowsPerCommit`.
4. User cannot sync without manual intervention.

This is safer than silent truncation, but not shippable.

## Attack / Failure Scenarios

### Scenario 1: Memory Exhaustion On Client

CLI reads all rows and CAS object metadata into arrays before planning and
committing.

Impact: large local store can make `prosa sync` consume excessive memory.

### Scenario 2: Object Upload Before Commit Limit Failure

CLI can upload many CAS objects, then `commitUpload` rejects row count.

Impact: orphan uploaded objects and user confusion.

### Scenario 3: Retry Storm

User repeatedly runs sync on a large bundle. Each attempt uploads/checks many
objects and fails at commit.

Impact: unnecessary server/object-store load.

## Required Changes

### 1. Add Preflight Local Cardinality Check

Before uploading object bytes, CLI must count:

- objects;
- source files;
- raw records;
- sessions;
- search docs;
- total rows.

If the current protocol cannot handle the bundle, fail before object upload
with a clear message or switch to chunked mode.

### 2. Implement Chunked Manifest Upload

Introduce protocol operations:

```text
sync.beginUpload
sync.addObjectManifestChunk
sync.addProjectionChunk
sync.commitManifest
sync.uploadObjectBytes
sync.finalizeUpload
sync.verifyPromotion
```

Alternative naming is fine, but the server must own the manifest incrementally.

### 3. Chunk Projection Rows

Projection rows should be uploaded in chunks with:

- sequence number;
- chunk hash;
- entity type;
- row count;
- idempotency key.

Server must reject:

- duplicate chunk with different hash;
- missing chunk;
- out-of-order finalize if order matters;
- entity count mismatch.

### 4. Resume Support

The protocol should allow:

- resume after object upload failure;
- resume after projection chunk failure;
- status query by batch id;
- skip already accepted chunks.

### 5. Memory-Bounded CLI

CLI should stream rows from SQLite where feasible instead of materializing the
entire bundle.

If the local SQLite API used here does not support streaming easily, paginate
by stable primary key.

## Acceptance Criteria

- Bundle with more than 10k rows syncs successfully via chunked path.
- Bundle with more than `maxObjectsPerPlan` syncs successfully via multiple
  object manifest chunks.
- CLI does not upload object bytes if preflight determines server cannot
  accept the bundle.
- Retrying after a failed chunk does not duplicate rows or corrupt state.
- Server-owned manifest counts match local preflight counts.
- `--purge-bundle` remains blocked until all chunks and objects are verified.

## Required Tests

- `apps/cli/test/cli/sync-large-bundle.test.ts`
  - creates >10k local rows;
  - syncs with fake/test API;
  - asserts chunk calls and final receipt.

- `apps/api/test/sync-chunks.test.ts`
  - duplicate same chunk is idempotent;
  - duplicate different chunk hash fails;
  - missing chunk prevents finalize;
  - count mismatch prevents verify.

- Docker E2E:
  - run a >10k row sync against Postgres + MinIO.

## Files Likely Touched

- `packages/prosa-sync/src/index.ts`
- `apps/api/src/trpc/routers/sync.ts`
- `apps/cli/src/cli/commands/sync.ts`
- `apps/cli/src/cli/auth/client.ts`
- `packages/prosa-db/src/migrate.ts`
- `packages/prosa-db/src/schema/sync.ts`
- tests in `apps/api/test` and `apps/cli/test`.

## Non-Goals

- Do not add every projection table here. This lane only makes the existing
  uploaded entities scalable.
- Do not implement object streaming here unless Lane 03 has not already done
  it.

