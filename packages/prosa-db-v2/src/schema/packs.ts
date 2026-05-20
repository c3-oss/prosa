// Postgres v2 schema — remote pack inventory, object catalogue, and
// receipt-scoped grants.

export const PACKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS remote_pack (
  tenant_id                TEXT NOT NULL,
  pack_digest              TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('cas_object_pack', 'raw_source_pack')),
  entry_count              INTEGER NOT NULL,
  byte_length              BIGINT NOT NULL,
  byte_hash                TEXT,
  object_set_root          TEXT NOT NULL,
  standalone_large_object  BOOLEAN NOT NULL DEFAULT FALSE,
  storage_uri              TEXT NOT NULL,
  ingested_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pack_digest)
);
ALTER TABLE remote_pack ADD COLUMN IF NOT EXISTS byte_hash TEXT;
CREATE INDEX IF NOT EXISTS remote_pack_tenant_idx ON remote_pack (tenant_id, ingested_at DESC);

CREATE TABLE IF NOT EXISTS remote_pack_entry (
  tenant_id          TEXT NOT NULL,
  pack_digest        TEXT NOT NULL,
  entry_index        INTEGER NOT NULL,
  object_id          TEXT NOT NULL,
  uncompressed_size  BIGINT NOT NULL,
  stored_offset      BIGINT NOT NULL,
  stored_length      BIGINT NOT NULL,
  stored_hash        TEXT NOT NULL,
  compression        TEXT NOT NULL CHECK (compression IN ('zstd', 'none')),
  PRIMARY KEY (tenant_id, pack_digest, entry_index)
);
CREATE INDEX IF NOT EXISTS remote_pack_entry_object_idx
  ON remote_pack_entry (tenant_id, object_id);

CREATE TABLE IF NOT EXISTS remote_object (
  tenant_id          TEXT NOT NULL,
  object_id          TEXT NOT NULL,
  uncompressed_size  BIGINT NOT NULL,
  pack_digest        TEXT NOT NULL,
  entry_index        INTEGER NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_id)
);

CREATE TABLE IF NOT EXISTS receipt_pack_grant (
  receipt_id   TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  pack_digest  TEXT NOT NULL,
  grant_mode   TEXT NOT NULL DEFAULT 'all_entries' CHECK (grant_mode IN ('all_entries')),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (receipt_id, tenant_id, pack_digest)
);
CREATE INDEX IF NOT EXISTS receipt_pack_grant_tenant_pack_idx
  ON receipt_pack_grant (tenant_id, pack_digest);

CREATE TABLE IF NOT EXISTS pack_audit_state (
  tenant_id     TEXT NOT NULL,
  pack_digest   TEXT NOT NULL,
  last_audit_at TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'drift', 'quarantined')),
  details       JSONB,
  PRIMARY KEY (tenant_id, pack_digest)
);

CREATE TABLE IF NOT EXISTS pack_gc_state (
  tenant_id          TEXT NOT NULL,
  pack_digest        TEXT NOT NULL,
  unreferenced_since TIMESTAMPTZ NOT NULL,
  deleted_at         TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, pack_digest)
);
`
