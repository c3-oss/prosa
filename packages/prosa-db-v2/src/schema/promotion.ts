// Postgres v2 schema — promotion staging + receipts + remote authority.

export const PROMOTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS promotion_staging (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  user_id                  TEXT NOT NULL,
  device_id                TEXT NOT NULL,
  store_id                 TEXT NOT NULL,
  store_path               TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('open', 'uploading', 'materializing', 'sealed', 'aborted')),
  head_json                JSONB NOT NULL,
  inventory_object_ref     TEXT,
  inventory_projection_ref TEXT,
  expected_object_count    INTEGER,
  expected_row_count       INTEGER,
  error                    JSONB,
  -- CQ-136: the exact receipt id sealed by THIS promotion. Set
  -- inside the seal transaction so an idempotent re-seal returns
  -- the same receipt even after a newer promotion has overwritten
  -- the store's authority pointer. NULL until seal succeeds.
  sealed_receipt_id        TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Allow the column to be added to pre-existing tables when re-applying
-- the schema (test harness re-runs the same SQL on every PGlite).
ALTER TABLE promotion_staging ADD COLUMN IF NOT EXISTS sealed_receipt_id TEXT;
CREATE INDEX IF NOT EXISTS promotion_staging_tenant_store_idx
  ON promotion_staging (tenant_id, store_id, created_at DESC);

-- CQ-128: at most one ACTIVE staging row per (tenant, store, bundleRoot).
-- A terminal row (sealed/aborted) does not occupy the slot, so a fresh
-- bundle can always open a new active row. Two concurrent fresh
-- BeginPromotion calls race on this unique index instead of both
-- INSERTing.
CREATE UNIQUE INDEX IF NOT EXISTS promotion_staging_active_tuple_idx
  ON promotion_staging (tenant_id, store_id, (head_json->>'bundleRoot'))
  WHERE status IN ('open', 'uploading', 'materializing');

CREATE TABLE IF NOT EXISTS remote_authority_v2 (
  tenant_id               TEXT NOT NULL,
  store_id                TEXT NOT NULL,
  current_receipt_id      TEXT NOT NULL,
  current_bundle_root     TEXT NOT NULL,
  promoted_at             TIMESTAMPTZ NOT NULL,
  cleanup_acknowledged_at TIMESTAMPTZ,
  cleanup_completed_at    TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, store_id)
);

CREATE TABLE IF NOT EXISTS receipt (
  receipt_id   TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  payload      JSONB NOT NULL,
  signature    JSONB NOT NULL,
  signed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipt_tenant_store_idx
  ON receipt (tenant_id, store_id, signed_at DESC);

-- Legacy v1 receipts archived during the Lane 10 cutover.
CREATE TABLE IF NOT EXISTS legacy_receipt_archive (
  receipt_id   TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  payload      JSONB NOT NULL,
  signature    JSONB,
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lane 9: v1 source-file catalog the server-side re-projection
-- walks to migrate a tenant. Rows are seeded by the Lane 10 cutover
-- shim (or by POST /v2/migrate/tenant in test environments) and
-- consumed by the tenant migrator. The table is migration-only;
-- v2 reads do not query it.
CREATE TABLE IF NOT EXISTS legacy_v1_source_files (
  tenant_id        TEXT NOT NULL,
  store_id         TEXT NOT NULL,
  source_file_id   TEXT NOT NULL,
  source_tool      TEXT NOT NULL,
  path             TEXT NOT NULL,
  file_kind        TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  storage_key      TEXT NOT NULL,
  size_bytes       BIGINT,
  inserted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_file_id)
);
CREATE INDEX IF NOT EXISTS legacy_v1_source_files_store_idx
  ON legacy_v1_source_files (tenant_id, store_id);

-- Lane 9: migration gap log. Each row records a v1 source file the
-- migrator could not re-project (raw bytes missing, decompression
-- failed, object store reported wrong size). Audit-only.
CREATE TABLE IF NOT EXISTS legacy_v1_migration_gap (
  tenant_id        TEXT NOT NULL,
  source_file_id   TEXT NOT NULL,
  source_tool      TEXT NOT NULL,
  reason           TEXT NOT NULL,
  detail           TEXT,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_file_id)
);

-- Per-promotion linkage from a staging slot to the object packs the
-- client uploaded. SealPromotion reads this to determine which pack
-- digests need a receipt_pack_grant row. Idempotent under retries
-- via the composite PK.
CREATE TABLE IF NOT EXISTS promotion_uploaded_pack (
  promotion_id TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  pack_digest  TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (promotion_id, pack_digest)
);
CREATE INDEX IF NOT EXISTS promotion_uploaded_pack_tenant_idx
  ON promotion_uploaded_pack (tenant_id, promotion_id);
`
