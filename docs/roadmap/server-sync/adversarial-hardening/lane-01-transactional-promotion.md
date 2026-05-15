# Lane 01: Transactional Promotion State Machine

Severity: critical

## Problem

`sync.commitUpload` performs a long sequence of independent `rawExec` calls:

- insert remote object catalog rows;
- insert tenant object provenance;
- insert sessions;
- insert source files;
- insert raw records;
- insert search docs;
- update `sync_batch` to `committed`.

If any step fails in the middle, earlier rows remain in the database. The
server read routes query `projection_session` and `search_doc` directly by
tenant, without requiring that the source batch has reached `verified`.

That means a failed promotion can leave partial data visible to remote reads.
It also means retries operate over partially applied state with unclear
semantics. Current `ON CONFLICT DO NOTHING` prevents some duplicate inserts,
but it also hides mismatch cases and does not give an all-or-nothing guarantee.

## Attack / Failure Scenarios

### Scenario 1: Partial Projection Exposure

1. Client uploads valid object bytes.
2. Client calls `commitUpload` with sessions and search docs.
3. Session inserts succeed.
4. Source file/raw record insert fails because of a FK or schema mismatch.
5. `sync_batch` is not marked committed.
6. `sessions.list` still returns the session because it reads
   `projection_session` directly.

Impact: remote reads expose unverified, incomplete data.

### Scenario 2: Cleanup Decision Based On Later Confusion

1. Partial rows remain from a failed commit.
2. Client retries with a smaller declaration set or empty declaration arrays.
3. Verification uses current tenant tables, not an immutable batch-applied set.
4. Receipt may represent mixed state across attempts.

Impact: local cleanup can become disconnected from what was actually promoted
for the batch.

### Scenario 3: Replay Masks Conflicting Data

1. Batch commit partially succeeds.
2. Retry sends the same IDs with different metadata.
3. `ON CONFLICT DO NOTHING` preserves old rows and hides the mismatch.

Impact: client believes new data was promoted, but server retained stale
projection.

## Required Changes

### 1. Introduce Transaction-Capable Database API

Current `RawExec` cannot express transaction boundaries safely.

Add an API such as:

```ts
export type RawTx = RawExec

export type DatabaseHandle = {
  rawExec: RawExec
  transaction<T>(fn: (tx: RawTx) => Promise<T>): Promise<T>
}
```

For `postgres`, use `client.begin(...)`.

For PGlite, use `BEGIN`, `COMMIT`, `ROLLBACK` around the callback, or the
PGlite transaction API if available.

### 2. Make `commitUpload` Atomic

All DB writes for one commit must run in a single transaction:

- validate batch row and status with row-level lock where supported;
- validate device ownership;
- validate object catalog metadata;
- insert remote object catalog rows;
- insert tenant object rows;
- insert projection rows;
- update batch status;
- write batch applied metadata.

If any write fails, no projection/object provenance rows from that commit
should remain.

### 3. Add Batch State Transitions

Use explicit states:

```text
open -> committing -> committed -> verifying -> verified
open/committing/committed/verifying -> failed
```

Rules:

- `commitUpload` can only start from `open`.
- `verifyPromotion` can only start from `committed`.
- `ackCleanup` can only run after `verified`.
- Retrying `commitUpload` after an unknown failure should either resume from a
  server-owned applied manifest or require a new batch.

### 4. Prevent Unverified Reads

Projection rows should either:

- include `sync_batch_id`, with read routes filtering to verified batches; or
- be staged in batch tables and copied into readable projection tables only
  after verification.

The safer design is staging:

```text
sync_stage_session
sync_stage_source_file
sync_stage_raw_record
sync_stage_search_doc
```

Then verification promotes staged rows into canonical remote projection in one
transaction.

If staging is too large for this lane, add `sync_batch_id` to projection tables
and update all remote reads to include only rows whose batch is `verified`.

## Acceptance Criteria

- A synthetic failure halfway through `commitUpload` leaves no readable
  projection rows.
- A retry after a failed commit cannot silently mix old and new projection data.
- `sessions.list`, `sessions.get`, `search.query`, and `analytics.summary` do
  not expose rows from non-verified batches.
- `ackCleanup` rejects unknown, failed, open, committing, committed, or
  verifying batches.
- Batch state transitions are tested and documented.

## Required Tests

### Unit / Integration

- `apps/api/test/sync-transaction.test.ts`
  - inject failure after session insert and assert no session is readable;
  - inject failure after source file insert and assert no partial rows remain;
  - replay same batch after failure and assert deterministic behavior.

- `apps/api/test/read-verified-only.test.ts`
  - manually insert an unverified projection row and assert read routes do not
    return it;
  - verify a batch and assert rows become visible.

### E2E

- Add Docker E2E case:
  - start real Postgres + MinIO;
  - force a commit failure using a bad raw record FK;
  - confirm Device B cannot see partial data.

## Files Likely Touched

- `apps/api/src/db.ts`
- `apps/api/src/trpc/routers/sync.ts`
- `apps/api/src/trpc/routers/reads.ts`
- `packages/prosa-db/src/migrate.ts`
- `packages/prosa-db/src/schema/*`
- `apps/api/test/*`

## Non-Goals

- Do not implement remote read feature parity here; only ensure existing remote
  reads do not expose unverified rows.
- Do not redesign object storage here; that is Lane 03.

