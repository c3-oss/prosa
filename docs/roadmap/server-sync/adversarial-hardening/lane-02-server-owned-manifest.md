# Lane 02: Server-Owned Batch Manifest And Receipts

Severity: critical

## Problem

The server currently relies too much on client-provided declarations during
`verifyPromotion`.

The client sends:

- declared object ids;
- declared source file ids;
- declared raw record ids;
- declared session ids;
- declared search doc ids.

The server checks that those ids exist, but it does not own an immutable
manifest created at plan/commit time. A malicious or buggy client can omit ids
from verification, verify with empty arrays, or verify a batch using a
`storePath` that was not originally bound to the batch.

The current receipt also counts tenant-wide rows, not rows proven for the
specific batch/store. That makes the receipt weaker as an audit artifact.

## Attack / Failure Scenarios

### Scenario 1: Partial Declaration Receipt

1. Client plans 1000 objects and rows.
2. Client commits only 10 sessions.
3. Client calls `verifyPromotion` with declarations for only those 10 sessions.
4. Server emits receipt for the tenant state.

Impact: receipt does not prove the original local bundle was promoted.

### Scenario 2: Empty Declaration Receipt

1. Client opens and commits an empty batch.
2. Client verifies with all declaration arrays empty.
3. Server emits remote authority for the provided store path.

Impact: malicious client can create a remote-authority marker without proving
bundle contents. The official CLI currently sends declarations, but security
cannot rely on a well-behaved CLI.

### Scenario 3: Store Path Confusion

1. Batch was opened for one `storePath`.
2. `verifyPromotion` is called with another `storePath`.
3. `remote_authority` is written for the verification input, not necessarily
   the batch's original store.

Impact: server-side authority records can be forged or made misleading.

### Scenario 4: Batch Object Set Drift

1. `planUpload` receives object manifest A.
2. `commitUpload` receives object manifest B.
3. Server accepts B because the plan manifest was not persisted.

Impact: plan/commit/verify are not cryptographically or structurally tied
together.

## Required Changes

### 1. Persist Plan Manifest

Create server-owned tables:

```text
sync_batch_object_manifest
sync_batch_source_file_manifest
sync_batch_raw_record_manifest
sync_batch_session_manifest
sync_batch_search_doc_manifest
```

At minimum for this lane:

```text
sync_batch_object_manifest(
  batch_id,
  tenant_id,
  object_id,
  canonical_hash,
  transport_hash,
  compression,
  uncompressed_size,
  compressed_size,
  storage_key,
  content_type
)

sync_batch_projection_manifest(
  batch_id,
  tenant_id,
  entity_type,
  entity_id
)
```

The manifest must be created by the server during plan/commit and treated as
the source of truth during verification.

### 2. Bind Batch To Store Path

Add `store_path` to `sync_batch`.

Rules:

- `planUpload` writes `store_path`.
- `commitUpload` must match the batch's `store_path`.
- `verifyPromotion` must not accept a different `storePath`.
- `remote_authority.store_path` must come from the batch row, not the verify
  input.

### 3. Require Complete Manifest Verification

`verifyPromotion` should not accept arbitrary declaration arrays as the proof.
It should use the server-owned manifest.

Valid options:

- remove declaration arrays from verify input entirely; or
- keep them as client-side smoke checks, but verify them against the
  server-owned manifest and fail if they differ.

The receipt should include:

- batch id;
- tenant id;
- device id;
- store path from batch;
- manifest counts;
- verified counts;
- hash of the manifest;
- verified timestamp;
- cleanup eligibility.

### 4. Make Receipts Batch-Scoped

Receipt counts must describe the batch/store, not total tenant state.

Current tenant-wide counts are useful as analytics, but they are not proof of
promotion. If kept, they should be named separately:

```text
tenantSessionCount
batchSessionCount
```

## Acceptance Criteria

- `verifyPromotion` fails if called with empty declarations for a non-empty
  batch.
- `verifyPromotion` fails if `storePath` differs from the batch's `store_path`.
- `verifyPromotion` uses server-owned manifest rows as the source of truth.
- Receipt includes batch-scoped counts and manifest hash.
- A client cannot plan object set A and commit object set B without server
  detecting the mismatch.
- `remote_authority` can only be created from a verified batch.

## Required Tests

- `apps/api/test/sync-manifest.test.ts`
  - plan A, commit B -> fail;
  - verify with omitted ids -> fail;
  - verify with empty arrays for non-empty batch -> fail;
  - verify wrong store path -> fail;
  - receipt counts match batch, not tenant totals.

- `apps/cli/test/cli/sync-manifest.test.ts`
  - CLI receives receipt whose counts equal local declared rows.

## Files Likely Touched

- `packages/prosa-db/src/migrate.ts`
- `packages/prosa-db/src/schema/sync.ts`
- `packages/prosa-sync/src/index.ts`
- `apps/api/src/trpc/routers/sync.ts`
- `apps/cli/src/cli/commands/sync.ts`
- `apps/api/test/*`
- `apps/cli/test/*`

## Non-Goals

- Do not implement chunking here. If a manifest is too large for one request,
  Lane 05 will address chunked manifests.
- Do not change object byte verification here except as needed to persist
  transport hash. Lane 03 owns object store hardening.

