# Lane 03: CAS/Object Store Hardening

Severity: critical/high

## Problem

The object route now validates canonical BLAKE3, but it is still not hardened
enough for adversarial inputs or large real-world CAS objects.

Current risks:

- PUT buffers the whole object body in memory.
- zstd payloads are fully decompressed in-process.
- No explicit object route `bodyLimit` is aligned with protocol limits.
- The route accepts uploads not tied to an open batch manifest.
- Orphan objects can be uploaded by any authenticated tenant member.
- `remote_object` does not persist `transport_hash`, so later verification
  cannot fully re-check zstd object-store metadata.
- GET buffers the whole object into memory instead of streaming.
- Zero-byte objects are rejected by the HTTP route even though schemas allow
  nonnegative sizes and CAS systems can validly represent empty content.

## Attack / Failure Scenarios

### Scenario 1: Decompression Bomb

1. Authenticated tenant member sends a small zstd body that expands massively.
2. Server buffers and decompresses it.
3. Process memory spikes before validation rejects or accepts.

Impact: denial of service.

### Scenario 2: Storage Abuse Via Orphan Uploads

1. Authenticated user signs up for a tenant.
2. User repeatedly calls `PUT /objects/:objectId` with valid hashes.
3. Objects are stored globally and remote_object rows are created.
4. No batch ever commits or references them.

Impact: storage exhaustion and unowned catalog growth.

### Scenario 3: Re-Verification Cannot Prove zstd Bytes

1. zstd object is uploaded with transport hash T and canonical hash C.
2. `remote_object` stores C but not T.
3. Later `verifyPromotion` checks sizes but cannot compare object-store head
   hash against T.

Impact: if object-store bytes are overwritten or metadata drifts, verification
can miss same-size corruption.

### Scenario 4: Large CAS Object Fails Unexpectedly

Protocol advertises `maxObjectBytes = 256MB`, but Fastify default body limits
and buffering may reject or crash much smaller/larger objects depending on
runtime behavior.

Impact: advertised protocol limits do not match actual server behavior.

## Required Changes

### 1. Store Transport Hash Separately

Add to `remote_object`:

```text
transport_hash text NOT NULL
transport_hash_algorithm text NOT NULL DEFAULT 'blake3'
```

Rules:

- `hash` remains canonical uncompressed hash.
- `transport_hash` is hash of stored bytes.
- For `compression=none`, `transport_hash = hash`.
- For `compression=zstd`, they usually differ.

`verifyPromotion` must compare object-store head hash to `transport_hash`.

### 2. Bind Uploads To Batch Manifests

Object PUT should require a batch context:

```text
PUT /objects/:objectId?batchId=...
```

or a signed upload token created by `planUpload`.

The server must verify:

- caller owns the batch;
- batch is open;
- object id exists in the batch manifest;
- uploaded metadata matches the manifest;
- upload has not already been completed with different bytes.

This eliminates orphan uploads and makes object storage accountable.

### 3. Stream Upload Verification

Avoid buffering entire bodies where possible.

Required behavior:

- compute transport hash while streaming;
- enforce compressed byte limit while streaming;
- write to temp object/key first;
- verify canonical hash with bounded decompression;
- finalize object atomically or delete temp object.

If streaming zstd verification is not practical immediately, enforce a much
smaller safe body limit until a streaming path exists.

### 4. Add Explicit Body Limits

Configure Fastify/object route body limit intentionally.

The limit must be:

- documented in handshake limits;
- enforced before buffering;
- tested.

Do not rely on framework defaults.

### 5. Stream GET Responses

GET `/objects/:objectId` should stream object bytes from the object store to the
reply without reading the full object into a Buffer.

Also add:

- content length from metadata where available;
- compression metadata headers;
- no-store cache headers unless intentional.

### 6. Decide Zero-Byte Object Semantics

Either:

- explicitly support zero-byte CAS objects end to end; or
- reject them in protocol schema, CLI, and server consistently.

Current mismatch is a bug.

## Acceptance Criteria

- Object PUT cannot be called for objects not present in an open batch manifest
  or without a valid upload token.
- Object PUT rejects decompression bombs before excessive allocation.
- Object PUT enforces advertised size limits.
- `remote_object` persists `transport_hash`.
- `verifyPromotion` checks object-store metadata against `transport_hash`,
  canonical hash, compression, and sizes.
- GET streams object bytes without buffering the whole object.
- Zero-byte behavior is consistent across schema, CLI, API, tests.

## Required Tests

- `apps/api/test/object-upload-hardening.test.ts`
  - PUT without batch/upload token fails;
  - PUT object not in manifest fails;
  - PUT with transport hash mismatch fails;
  - PUT with canonical hash mismatch fails;
  - PUT zstd same-size wrong transport hash fails verify;
  - oversized compressed body fails;
  - decompression over limit fails;
  - zero-byte accepted or rejected consistently.

- `apps/api/test/e2e/postgres-s3.e2e.test.ts`
  - assert MinIO metadata includes transport hash;
  - corrupt/replace object metadata in MinIO and assert verify fails.

## Files Likely Touched

- `apps/api/src/http/objects.ts`
- `apps/api/src/app.ts`
- `apps/api/src/trpc/routers/sync.ts`
- `packages/prosa-storage/src/types.ts`
- `packages/prosa-storage/src/adapters/*`
- `packages/prosa-db/src/migrate.ts`
- `packages/prosa-db/src/schema/objects.ts`
- `packages/prosa-sync/src/index.ts`
- `apps/cli/src/cli/auth/client.ts`
- `apps/cli/src/cli/commands/sync.ts`

## Non-Goals

- Do not solve all batch transactionality here. Lane 01 owns transactions.
- Do not solve large bundle chunking here. Lane 05 owns chunking.

