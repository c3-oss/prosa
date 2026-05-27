// Postgres v2 schema — projection mirrors (subset of canonical entities
// that the server materializes for read endpoints).
//
// Per the lean profile (docs/rearch-2/00-README.md), the server keeps
// the *minimal* set of canonical projection rows needed to serve the
// read API. Heavy analytics live in DuckDB/Parquet locally; the server
// projection is for receipt-pinned reads (Lane 6).
//
// Partitioning: every projection table is partitioned by hash of
// `tenant_id`. The lean profile uses 8 buckets; production can re-shard
// if a single tenant becomes hot.

export const PROJECTION_BUCKETS = 8

// Lane 6 — store_id and receipt_id are required on every projection
// row so the read API can join against `remote_authority_v2` to enforce
// the verified-projection gate (see
// `apps/api/src/v2/reads/shared/verified-projection.ts`). They are
// populated by the seal-promotion materialization path. CQ-134's full
// projection materialization is Lane 10 scope; until then these
// columns exist but are empty in production, and Lane 6 tests seed
// rows directly.

export const PROJECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projection_session (
  tenant_id            TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  store_id             TEXT NOT NULL,
  receipt_id           TEXT NOT NULL,
  source_tool          TEXT NOT NULL,
  source_session_id    TEXT NOT NULL,
  project_id           TEXT,
  parent_session_id    TEXT,
  parent_resolution    TEXT NOT NULL,
  is_subagent          BOOLEAN NOT NULL DEFAULT FALSE,
  title                TEXT,
  summary              TEXT,
  start_ts             TIMESTAMPTZ,
  end_ts               TIMESTAMPTZ,
  status               TEXT,
  timeline_confidence  TEXT NOT NULL,
  raw_record_id        TEXT,
  payload              JSONB NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX IF NOT EXISTS projection_session_tenant_end_idx
  ON projection_session (tenant_id, end_ts DESC);
CREATE INDEX IF NOT EXISTS projection_session_store_idx
  ON projection_session (tenant_id, store_id, end_ts DESC);

CREATE TABLE IF NOT EXISTS projection_message (
  tenant_id          TEXT NOT NULL,
  message_id         TEXT NOT NULL,
  store_id           TEXT NOT NULL,
  receipt_id         TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  turn_id            TEXT,
  role               TEXT NOT NULL,
  model              TEXT,
  timestamp          TIMESTAMPTZ,
  ordinal            INTEGER NOT NULL,
  parent_message_id  TEXT,
  payload            JSONB NOT NULL,
  PRIMARY KEY (tenant_id, message_id)
);
CREATE INDEX IF NOT EXISTS projection_message_session_idx
  ON projection_message (tenant_id, session_id, ordinal);

CREATE TABLE IF NOT EXISTS projection_tool_call (
  tenant_id           TEXT NOT NULL,
  tool_call_id        TEXT NOT NULL,
  store_id            TEXT NOT NULL,
  receipt_id          TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  turn_id             TEXT,
  tool_name           TEXT NOT NULL,
  canonical_tool_type TEXT,
  timestamp_start     TIMESTAMPTZ,
  status              TEXT,
  payload             JSONB NOT NULL,
  PRIMARY KEY (tenant_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS projection_tool_call_session_idx
  ON projection_tool_call (tenant_id, session_id, timestamp_start);

CREATE TABLE IF NOT EXISTS projection_tool_result (
  tenant_id        TEXT NOT NULL,
  tool_result_id   TEXT NOT NULL,
  store_id         TEXT NOT NULL,
  receipt_id       TEXT NOT NULL,
  tool_call_id     TEXT,
  session_id       TEXT NOT NULL,
  status           TEXT,
  is_error         BOOLEAN NOT NULL DEFAULT FALSE,
  exit_code        INTEGER,
  duration_ms      INTEGER,
  payload          JSONB NOT NULL,
  PRIMARY KEY (tenant_id, tool_result_id)
);

CREATE TABLE IF NOT EXISTS projection_event (
  tenant_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  store_id      TEXT NOT NULL,
  receipt_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  turn_id       TEXT,
  event_type    TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  timestamp     TIMESTAMPTZ,
  actor         TEXT,
  payload       JSONB NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);
CREATE INDEX IF NOT EXISTS projection_event_session_idx
  ON projection_event (tenant_id, session_id, ordinal);

CREATE TABLE IF NOT EXISTS projection_content_block (
  tenant_id      TEXT NOT NULL,
  block_id       TEXT NOT NULL,
  store_id       TEXT NOT NULL,
  receipt_id     TEXT NOT NULL,
  message_id     TEXT,
  session_id     TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  block_type     TEXT NOT NULL,
  is_error       BOOLEAN NOT NULL DEFAULT FALSE,
  is_redacted    BOOLEAN NOT NULL DEFAULT FALSE,
  visibility     TEXT NOT NULL,
  text_inline    TEXT,
  object_id      TEXT,
  payload        JSONB NOT NULL,
  PRIMARY KEY (tenant_id, block_id)
);

CREATE TABLE IF NOT EXISTS projection_artifact (
  tenant_id     TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  store_id      TEXT NOT NULL,
  receipt_id    TEXT NOT NULL,
  session_id    TEXT,
  project_id    TEXT,
  source_tool   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  object_id     TEXT,
  byte_length   BIGINT,
  content_type  TEXT,
  payload       JSONB NOT NULL,
  PRIMARY KEY (tenant_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS projection_edge (
  tenant_id    TEXT NOT NULL,
  edge_id      TEXT NOT NULL,
  src_type     TEXT NOT NULL,
  src_id       TEXT NOT NULL,
  dst_type     TEXT NOT NULL,
  dst_id       TEXT NOT NULL,
  edge_type    TEXT NOT NULL,
  confidence   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  PRIMARY KEY (tenant_id, edge_id)
);
CREATE INDEX IF NOT EXISTS projection_edge_endpoints_idx
  ON projection_edge (tenant_id, src_type, src_id);

CREATE TABLE IF NOT EXISTS projection_project (
  tenant_id            TEXT NOT NULL,
  project_id           TEXT NOT NULL,
  canonical_path       TEXT,
  display_name         TEXT,
  payload              JSONB NOT NULL,
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE IF NOT EXISTS projection_raw_record (
  tenant_id        TEXT NOT NULL,
  raw_record_id    TEXT NOT NULL,
  source_file_id   TEXT NOT NULL,
  record_kind      TEXT NOT NULL,
  ordinal          INTEGER,
  content_hash     TEXT NOT NULL,
  object_id        TEXT NOT NULL,
  payload          JSONB NOT NULL,
  PRIMARY KEY (tenant_id, raw_record_id)
);

CREATE TABLE IF NOT EXISTS projection_source_file (
  tenant_id        TEXT NOT NULL,
  source_file_id   TEXT NOT NULL,
  source_tool      TEXT NOT NULL,
  path             TEXT NOT NULL,
  file_kind        TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  object_id        TEXT NOT NULL,
  pack_digest      TEXT NOT NULL,
  payload          JSONB NOT NULL,
  PRIMARY KEY (tenant_id, source_file_id)
);

CREATE TABLE IF NOT EXISTS projection_turn (
  tenant_id    TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  start_ts     TIMESTAMPTZ,
  end_ts       TIMESTAMPTZ,
  payload      JSONB NOT NULL,
  PRIMARY KEY (tenant_id, turn_id)
);
`
