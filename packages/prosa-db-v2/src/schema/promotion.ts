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
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotion_staging_tenant_store_idx
  ON promotion_staging (tenant_id, store_id, created_at DESC);

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
`
