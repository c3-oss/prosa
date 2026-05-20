// Postgres v2 schema — search_doc with a Postgres tsvector + GIN index.
//
// Lane 0 → CANONICAL_ENTITY_TYPES includes `search_doc`; the server
// materializes it into a denormalized table so the read API (Lane 6)
// can run Postgres full-text search without round-tripping to remote
// Tantivy. The lean profile drops the remote Tantivy fleet entirely.
//
// `search_generation_current` exposes the per-tenant search index
// generation pointer; cron audits validate it against the receipt
// chain. Defined here so the cron skeleton in Lane 8 has the table
// available.

export const SEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS search_doc (
  tenant_id            TEXT NOT NULL,
  doc_id               TEXT NOT NULL,
  entity_type          TEXT NOT NULL,
  entity_id            TEXT NOT NULL,
  session_id           TEXT,
  project_id           TEXT,
  timestamp            TIMESTAMPTZ,
  role                 TEXT,
  tool_name            TEXT,
  canonical_tool_type  TEXT,
  field_kind           TEXT NOT NULL,
  errors_only          BOOLEAN NOT NULL DEFAULT FALSE,
  text                 TEXT NOT NULL,
  text_tsv             TSVECTOR,
  PRIMARY KEY (tenant_id, doc_id)
);
CREATE INDEX IF NOT EXISTS search_doc_tsv_idx ON search_doc USING GIN (text_tsv);
CREATE INDEX IF NOT EXISTS search_doc_session_idx ON search_doc (tenant_id, session_id);
CREATE INDEX IF NOT EXISTS search_doc_entity_idx ON search_doc (tenant_id, entity_type, entity_id);

-- CQ-137: per-store scoping. remote_authority_v2 is keyed by
-- (tenant_id, store_id); the generation pointer must follow the
-- same shape or promoting a second store in the same tenant would
-- overwrite the first.
CREATE TABLE IF NOT EXISTS search_generation_current (
  tenant_id              TEXT NOT NULL,
  store_id               TEXT NOT NULL,
  generation_id          TEXT NOT NULL,
  receipt_id             TEXT NOT NULL,
  promoted_at            TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id)
);
`
