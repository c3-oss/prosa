# Lane 4 — Server

## Goal

Ship the v2 server: Postgres-only schema (lean profile, no ClickHouse), Fastify API workers with streaming validation pipeline, Better Auth integration (preserved from v1), AWS KMS server-key signing, and the one-fleet operational model. After this lane, the server boots in production-mode config, can receive a `BeginPromotion` request, validates payloads, and signs receipts. **No sync flow is wired yet** — that comes in Lane 5.

This is a heavy lane. Plan for 5–6 PRs.

## Depends on

- Lane 0 (Foundation) complete — uses `prosa-types-v2` and `prosa-wire-v2`.
- Lane 3 (Derived layer) does NOT need to be complete; server work can begin once Lane 0 is in. But the practical sequencing keeps it after Lane 3 because the API workers will need the canonical schema confirmed.

## Deliverables

- New package `packages/prosa-db-v2` with Postgres schema (Drizzle) for v2.
- New routes / handlers under `apps/api/src/v2/` (alongside v1, not replacing).
- Better Auth wiring preserved; new endpoints for v2 sit under `/v2/*`.
- AWS KMS server-key integration for receipt signing.
- Streaming pack validation pipeline (bounded memory, zstd window enforced).
- `apps/api/src/cron/` directory for audit + GC roles (defined here, populated in Lane 8).
- `applySchemaV2(raw)` boot-time migration applied via `idempotent CREATE ... IF NOT EXISTS`.

## Tasks

1. **Postgres v2 schema (`packages/prosa-db-v2`).** All v2 tables: `device`, `sync_batch` → renamed `promotion_staging`, `remote_object`, `remote_pack`, `remote_pack_entry`, `receipt_pack_grant` (single grant mode), `remote_authority_v2`, `device_public_key` (schema reserved for v2.x even though signing is server-only in v2.0), `pack_audit_state`, `pack_gc_state`, `search_generation_current`, plus projection mirror tables (`projection_session`, `projection_message`, etc.) keyed `(tenant_id, id)` and partitioned by hash bucket of `tenant_id`. Plus `search_doc` with a `tsvector` column + GIN index. Plus the legacy `legacy_receipt_archive`.
2. **Schema migration boot-check.** `applySchemaV2(raw)` runs at startup. Required-table check fails boot if any of the load-bearing tables (`device`, `promotion_staging`, `remote_pack`, `receipt_pack_grant`, `remote_authority_v2`, `projection_session`, `search_doc`) is missing.
3. **Better Auth integration preserved.** No changes to auth flow. v1 `/api/auth/*` routes stay. New requests under `/v2/*` use the same `buildCreateContext` to resolve session/user/tenant.
4. **AWS KMS server signing.** Module `apps/api/src/v2/signing/kms.ts`: `signReceipt(payload) → { keyId, sig }`, `verifyReceipt(payload, sig, publicKey) → boolean`. JWKS endpoint at `/.well-known/prosa-receipt-keys.json` publishes current + N historical server public keys (retention infinite).
5. **Streaming pack validation pipeline.** `apps/api/src/v2/upload/validate.ts`: bounded-memory pipeline that for each pack stream computes pack-level BLAKE3, per-slice BLAKE3, zstd streaming decode → per-decompressed-block BLAKE3, S3 multipart upload of stored bytes. Hard limits: `maxZstdWindowBytes = 8 MiB` enforced (reject with `PACK_ZSTD_WINDOW_TOO_LARGE`); per-upload userland memory ≤ 16 MiB; per worker concurrent validations capped at 4.
6. **`/v2/.well-known/receipt-keys.json` endpoint.** Returns the JWKS for server-key verification.
7. **One-fleet cron skeleton.** `apps/api/src/cron/index.ts` registers audit and GC roles with `node-cron`. Both acquire Postgres advisory locks (`pg_advisory_lock`) before running, release on completion. Lane 8 fills in the actual audit / GC logic.

## Concrete types and schemas

### Postgres schema (lean profile)

```sql
-- packages/prosa-db-v2/src/schema/devices.sql

CREATE TABLE IF NOT EXISTS device (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  cli_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, name)
);

-- Schema reserved for v2.x device-key signing; not used in v2.0.
CREATE TABLE IF NOT EXISTS device_public_key (
  tenant_id              TEXT NOT NULL,
  device_id              TEXT NOT NULL,
  key_id                 TEXT NOT NULL,
  alg                    TEXT NOT NULL DEFAULT 'Ed25519',
  public_key             BYTEA NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from             TIMESTAMPTZ NOT NULL,
  valid_until            TIMESTAMPTZ,
  revoked_at             TIMESTAMPTZ,
  superseded_by_key_id   TEXT,
  PRIMARY KEY (tenant_id, device_id, key_id)
);
```

```sql
-- packages/prosa-db-v2/src/schema/promotion.sql

CREATE TABLE IF NOT EXISTS promotion_staging (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  device_id            TEXT NOT NULL,
  store_id             TEXT NOT NULL,
  store_path           TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('open', 'uploading', 'materializing', 'sealed', 'aborted')),
  head_json            JSONB NOT NULL,
  inventory_object_ref TEXT,
  inventory_projection_ref TEXT,
  expected_object_count INTEGER,
  expected_row_count   INTEGER,
  error                JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX promotion_staging_tenant_store_idx
  ON promotion_staging (tenant_id, store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_authority_v2 (
  tenant_id              TEXT NOT NULL,
  store_id               TEXT NOT NULL,
  current_receipt_id     TEXT NOT NULL,
  current_bundle_root    TEXT NOT NULL,
  promoted_at            TIMESTAMPTZ NOT NULL,
  cleanup_acknowledged_at TIMESTAMPTZ,
  cleanup_completed_at    TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, store_id)
);

CREATE TABLE IF NOT EXISTS receipt (
  receipt_id       TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  store_id         TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  payload          JSONB NOT NULL,
  signature        JSONB NOT NULL,
  signed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipt_tenant_store_idx
  ON receipt (tenant_id, store_id, signed_at DESC);
```

```sql
-- packages/prosa-db-v2/src/schema/packs.sql

CREATE TABLE IF NOT EXISTS remote_pack (
  tenant_id            TEXT NOT NULL,
  pack_digest          TEXT NOT NULL,
  storage_key          TEXT NOT NULL,
  byte_length          BIGINT NOT NULL,
  object_count         INTEGER NOT NULL,
  pack_header_digest   TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pack_digest)
);

CREATE TABLE IF NOT EXISTS remote_pack_entry (
  tenant_id           TEXT NOT NULL,
  pack_digest         TEXT NOT NULL,
  object_id           TEXT NOT NULL,
  byte_offset         BIGINT NOT NULL,
  stored_length       BIGINT NOT NULL,
  uncompressed_size   BIGINT NOT NULL,
  stored_hash         TEXT NOT NULL,
  uncompressed_hash   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, pack_digest, object_id)
);

-- Single grant mode (lean): all_entries only.
CREATE TABLE IF NOT EXISTS receipt_pack_grant (
  tenant_id            TEXT NOT NULL,
  receipt_id           TEXT NOT NULL,
  pack_digest          TEXT NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id, pack_digest)
);

CREATE TABLE IF NOT EXISTS pack_audit_state (
  tenant_id              TEXT NOT NULL,
  pack_digest            TEXT NOT NULL,
  last_header_check_at   TIMESTAMPTZ,
  last_full_hash_at      TIMESTAMPTZ,
  status                 TEXT NOT NULL CHECK (status IN ('ok', 'missing', 'hash_mismatch', 'quarantined')),
  error                  JSONB,
  PRIMARY KEY (tenant_id, pack_digest)
);

CREATE TABLE IF NOT EXISTS pack_gc_state (
  tenant_id                TEXT NOT NULL,
  pack_digest              TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('live', 'tombstone_pending', 'delete_pending', 'deleted', 'blocked')),
  first_unreferenced_at    TIMESTAMPTZ,
  deleted_at               TIMESTAMPTZ,
  error                    JSONB,
  PRIMARY KEY (tenant_id, pack_digest)
);
```

```sql
-- packages/prosa-db-v2/src/schema/projection.sql

-- Hash-bucket partitioning to avoid partition explosion with thousands of tenants.
CREATE TABLE IF NOT EXISTS projection_session (
  tenant_id            TEXT NOT NULL,
  id                   TEXT NOT NULL,
  source_tool          TEXT NOT NULL,
  source_session_id    TEXT NOT NULL,
  project_id           TEXT,
  parent_session_id    TEXT,
  parent_resolution    TEXT NOT NULL CHECK (parent_resolution IN ('inline', 'edge_derived', 'fixup_derived', 'unresolved')),
  is_subagent          BOOLEAN NOT NULL DEFAULT false,
  agent_role           TEXT,
  agent_nickname       TEXT,
  title                TEXT,
  summary              TEXT,
  start_ts             TIMESTAMPTZ,
  end_ts               TIMESTAMPTZ,
  cwd_initial          TEXT,
  git_branch_initial   TEXT,
  model_first          TEXT,
  model_last           TEXT,
  status               TEXT,
  timeline_confidence  TEXT NOT NULL DEFAULT 'high' CHECK (timeline_confidence IN ('high', 'medium', 'low')),
  workspace_hint       TEXT,
  receipt_id           TEXT NOT NULL,
  store_id             TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
)
PARTITION BY HASH (tenant_id);
-- 16 partitions for hash bucket; each can be further sub-partitioned later if scale demands.
CREATE TABLE projection_session_p00 PARTITION OF projection_session FOR VALUES WITH (MODULUS 16, REMAINDER 0);
-- ... p01 .. p15

CREATE INDEX projection_session_tenant_start_idx
  ON projection_session (tenant_id, start_ts DESC);
CREATE INDEX projection_session_tenant_store_idx
  ON projection_session (tenant_id, store_id, start_ts DESC);

-- Equivalent shapes for projection_message, projection_turn, projection_event,
-- projection_content_block, projection_tool_call, projection_tool_result,
-- projection_artifact, projection_edge, projection_raw_record, source_file, projects.

CREATE TABLE IF NOT EXISTS search_doc (
  tenant_id              TEXT NOT NULL,
  id                     TEXT NOT NULL,
  entity_type            TEXT NOT NULL,
  entity_id              TEXT NOT NULL,
  session_id             TEXT,
  project_id             TEXT,
  timestamp              TIMESTAMPTZ,
  role                   TEXT,
  tool_name              TEXT,
  canonical_tool_type    TEXT,
  field_kind             TEXT NOT NULL,
  errors_only            BOOLEAN NOT NULL DEFAULT false,
  text                   TEXT NOT NULL,
  tsv                    TSVECTOR
                         GENERATED ALWAYS AS (to_tsvector('english_unaccent', text)) STORED,
  receipt_id             TEXT NOT NULL,
  store_id               TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
)
PARTITION BY HASH (tenant_id);
CREATE TABLE search_doc_p00 PARTITION OF search_doc FOR VALUES WITH (MODULUS 16, REMAINDER 0);
-- ... p01 .. p15

-- GIN index on tsv plus btree on common filters.
CREATE INDEX search_doc_tsv_idx ON search_doc USING GIN (tsv);
CREATE INDEX search_doc_tenant_session_idx ON search_doc (tenant_id, session_id);
CREATE INDEX search_doc_tenant_role_idx ON search_doc (tenant_id, role) WHERE role IS NOT NULL;
CREATE INDEX search_doc_tenant_tool_idx ON search_doc (tenant_id, tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX search_doc_tenant_canontype_idx ON search_doc (tenant_id, canonical_tool_type) WHERE canonical_tool_type IS NOT NULL;
CREATE INDEX search_doc_tenant_errors_idx ON search_doc (tenant_id) WHERE errors_only = true;
```

```sql
-- packages/prosa-db-v2/src/schema/search-generation.sql

-- Single-engine remote search (Postgres FTS). Generation pointer kept for parity
-- with local Tantivy generation reporting, even though Postgres FTS is "always current".
CREATE TABLE IF NOT EXISTS search_generation_current (
  tenant_id            TEXT NOT NULL,
  store_id             TEXT NOT NULL,
  receipt_id           TEXT NOT NULL,
  generation_id        TEXT NOT NULL,
  PRIMARY KEY (tenant_id, store_id)
);
```

```sql
-- packages/prosa-db-v2/src/schema/legacy.sql

CREATE TABLE IF NOT EXISTS legacy_receipt_archive (
  tenant_id              TEXT NOT NULL,
  store_path             TEXT NOT NULL,
  old_receipt            JSONB NOT NULL,
  archived_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by_receipt_id TEXT,
  PRIMARY KEY (tenant_id, store_path)
);
```

### Streaming validation (bounded memory)

```ts
// apps/api/src/v2/upload/validate.ts

const MAX_ZSTD_WINDOW_BYTES = 8 * 1024 * 1024
const MAX_OBJECT_PACK_BYTES = 128 * 1024 * 1024
const PER_UPLOAD_READ_BUFFER = 512 * 1024
const PER_UPLOAD_S3_PART_BUFFER = 8 * 1024 * 1024
const MAX_CONCURRENT_PACK_VALIDATIONS_PER_WORKER = 4

export async function validateAndStorePack(
  ctx: V2RequestContext,
  packStream: ReadableStream<Uint8Array>,
): Promise<PackValidationResult> {
  // 1. Bounded reader.
  const reader = boundedReader(packStream, MAX_OBJECT_PACK_BYTES, PER_UPLOAD_READ_BUFFER)

  // 2. Pack-level BLAKE3 hasher.
  const packHasher = createBlake3()

  // 3. Stored-slice BLAKE3 hashers (one per entry, computed inline as bytes flow).
  const entryHashers = new Map<string, Blake3State>()

  // 4. zstd streaming decoder; window cap enforced.
  const zstdDecoder = createZstdStreamDecoder({ maxWindowBytes: MAX_ZSTD_WINDOW_BYTES })

  // 5. S3 multipart upload of stored (compressed) bytes only.
  const s3Upload = await ctx.objectStore.createMultipartUpload(targetKey)

  try {
    for await (const chunk of reader) {
      packHasher.update(chunk)
      // ... route chunk to entry hashers based on offset/length
      // ... feed chunk to zstd decoder, hash decompressed bytes per entry
      // ... append stored bytes to S3 multipart
      // Reject as soon as window violation detected:
      if (zstdDecoder.observedWindow() > MAX_ZSTD_WINDOW_BYTES) {
        await s3Upload.abort()
        throw new PackValidationError('PACK_ZSTD_WINDOW_TOO_LARGE', {
          maxWindowBytes: MAX_ZSTD_WINDOW_BYTES,
          actualWindowBytes: zstdDecoder.observedWindow(),
          action: 'reencode_pack',
        })
      }
    }
    // Validate per-entry hashes match declared `stored_hash` and `uncompressed_hash`.
    const validated = collectValidation(entryHashers, declaredHeader)
    await s3Upload.complete()
    return validated
  } catch (err) {
    await s3Upload.abort()
    throw err
  }
}
```

### KMS signing module

```ts
// apps/api/src/v2/signing/kms.ts
import { KMSClient, SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms'

const kms = new KMSClient({ region: process.env.AWS_REGION })

export async function signReceipt(payload: PromotionReceiptV2Payload): Promise<ReceiptSignature> {
  const payloadBytes = canonicalCbor(payload)
  const digest = blake3(payloadBytes)

  const result = await kms.send(new SignCommand({
    KeyId: process.env.PROSA_RECEIPT_SIGNING_KEY_ARN,
    Message: digest,
    MessageType: 'DIGEST',
    SigningAlgorithm: 'ECDSA_SHA_256', // Or use a KMS-supported algo; Ed25519 via KMS-asymmetric.
  }))

  return {
    alg: 'Ed25519',
    keyId: process.env.PROSA_RECEIPT_SIGNING_KEY_ID,
    sig: Buffer.from(result.Signature!).toString('base64url'),
  }
}

export async function publishJwks(): Promise<JsonWebKeySet> {
  // Returns current + N historical server public keys.
  // Retention is infinite — old keys must remain queryable for receipt audit.
}
```

### Cron skeleton

```ts
// apps/api/src/cron/index.ts
import cron from 'node-cron'
import { withAdvisoryLock } from './advisory-lock'

export function startCron(deps: CronDeps): void {
  // Audit role (defined in Lane 8).
  cron.schedule('0 * * * *', () => withAdvisoryLock('prosa-audit-hourly', () => runAuditHourly(deps)))
  cron.schedule('0 2 * * *', () => withAdvisoryLock('prosa-audit-daily', () => runAuditDaily(deps)))
  cron.schedule('0 3 * * 0', () => withAdvisoryLock('prosa-audit-weekly', () => runAuditWeekly(deps)))
  cron.schedule('0 4 1 * *', () => withAdvisoryLock('prosa-audit-monthly', () => runAuditMonthly(deps)))

  // GC role (defined in Lane 8).
  cron.schedule('0 1 * * *', () => withAdvisoryLock('prosa-gc-daily', () => runGcDaily(deps)))
}

// apps/api/src/cron/advisory-lock.ts
export async function withAdvisoryLock(lockName: string, fn: () => Promise<void>): Promise<void> {
  const lockId = hashStringToInt64(lockName)
  const acquired = await db.query<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock($1)', [lockId],
  )
  if (!acquired.rows[0].pg_try_advisory_lock) return // another worker holds it
  try {
    await fn()
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [lockId])
  }
}
```

## Tests

| File | Asserts |
|---|---|
| `packages/prosa-db-v2/test/schema-boot.test.ts` | `applySchemaV2` is idempotent; required-table check fails boot when a table is dropped. |
| `apps/api/test/v2/kms-sign-verify.test.ts` | **Invariant I5**: round-trip sign+verify of a receipt payload against KMS (mocked or real). |
| `apps/api/test/v2/streaming-validation.test.ts` | Pack with `zstd window_log = 24` rejected with `PACK_ZSTD_WINDOW_TOO_LARGE`. Pack with valid window passes. Memory footprint ≤ 16 MiB per upload measured via heap snapshot. |
| `apps/api/test/v2/jwks.test.ts` | `/v2/.well-known/receipt-keys.json` returns current + historical keys; old key never removed even after rotation. |
| `apps/api/test/v2/cron-advisory-lock.test.ts` | Two workers schedule the same cron job; only one acquires the advisory lock per tick. |
| `apps/api/test/v2/partition-explosion.test.ts` | Insert 100k rows across 1,000 synthetic tenants; verify 16 hash-bucket partitions hold ~6,250 rows each; query for one tenant prunes to the owning partition. |

## Gate

The lane is complete when:

1. All test files above pass.
2. `pnpm dev` (or equivalent) boots the API with `PROSA_RUNTIME_MODE=production` against a local Postgres + S3 (MinIO) without errors.
3. `curl http://localhost:3000/v2/.well-known/receipt-keys.json` returns a valid JWKS with at least one current key.
4. **Invariant I5 passes** (server signing roundtrip).
5. `applySchemaV2` is committed and runs idempotently across multiple boots.
6. No v2 endpoint actually accepts a `BeginPromotion` request yet — that wiring is Lane 5. But the route definitions exist and return `501 Not Implemented`.

## Risks

| Risk | Mitigation |
|---|---|
| Postgres hash-bucket partition strategy underperforms at 10k+ tenants | Bench at 100k tenants in a load test before Lane 10 cutover. Adjust `MODULUS` if needed. |
| Streaming validation memory exceeds budget | Heap snapshot test enforces ≤16 MiB; CI fails on regression. |
| KMS signing latency surprises | Bench: target ≤10 ms per sign. If > 50 ms, cache batch-sign before seal commit. |
| `tsvector` GIN index slow on huge corpora | Acceptable up to ~10–100M docs per partition. Re-evaluate at Lane 10 capacity test. |
| Cron advisory lock collisions across workers | Lock names are constants; `pg_try_advisory_lock` is non-blocking; worst case = the cron tick is skipped this round. |

## Unblocks

Lane 5 (`06-lane-5-sync-protocol.md`) — needs server schema + KMS signing + streaming validation pipeline to wire the four-call promotion protocol.
