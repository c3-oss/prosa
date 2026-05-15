// Auto-generated from schema description. Edit the SQL here directly.
// Loaded at runtime by core/schema/migrate.ts.

/**
 * Initial bundle schema.
 *
 * Defines the raw immutable layer, canonical projection tables, and derived
 * search index tables/triggers. Projection rows are rebuildable from preserved
 * raw records and CAS objects.
 */
export const SQL_001_INIT = String.raw`
-- Schema W v1
--
-- Three layers:
--   1. raw immutable      : raw_records pointing at preserved bytes (objects)
--   2. canonical projection: sessions, turns, events, messages, blocks,
--                            tool_calls, tool_results, artifacts, edges
--   3. derived indexes    : search_docs + FTS5
--
-- Projections are regenerable from raw_records. Raw is the source of truth.

CREATE TABLE IF NOT EXISTS objects (
  object_id              TEXT PRIMARY KEY,
  hash_alg               TEXT NOT NULL,
  hash                   TEXT NOT NULL,
  size_bytes             INTEGER NOT NULL,
  compressed_size_bytes  INTEGER,
  compression            TEXT NOT NULL DEFAULT 'zstd',
  mime_type              TEXT,
  encoding               TEXT,
  storage_path           TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS objects_hash_idx ON objects(hash_alg, hash);

CREATE TABLE IF NOT EXISTS source_files (
  source_file_id   TEXT PRIMARY KEY,
  source_tool      TEXT NOT NULL,
  path             TEXT NOT NULL,
  file_kind        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  mtime            TEXT,
  content_hash     TEXT NOT NULL,
  object_id        TEXT REFERENCES objects(object_id),
  discovered_at    TEXT NOT NULL,
  workspace_hint   TEXT,
  UNIQUE(source_tool, path, size_bytes, mtime, content_hash)
);

CREATE INDEX IF NOT EXISTS source_files_tool_idx ON source_files(source_tool);
CREATE INDEX IF NOT EXISTS source_files_hash_idx ON source_files(content_hash);

CREATE TABLE IF NOT EXISTS import_batches (
  batch_id        TEXT PRIMARY KEY,
  parser_version  TEXT NOT NULL,
  source_tool     TEXT,
  paths           TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  counts_json     TEXT
);

CREATE TABLE IF NOT EXISTS raw_records (
  raw_record_id            TEXT PRIMARY KEY,
  source_file_id           TEXT NOT NULL REFERENCES source_files(source_file_id),
  source_tool              TEXT NOT NULL,
  record_kind              TEXT NOT NULL,
  ordinal                  INTEGER,
  line_no                  INTEGER,
  json_pointer             TEXT,
  native_id                TEXT,
  raw_object_id            TEXT NOT NULL REFERENCES objects(object_id),
  decoded_json_object_id   TEXT REFERENCES objects(object_id),
  parser_status            TEXT NOT NULL,
  confidence               TEXT NOT NULL DEFAULT 'high',
  import_batch_id          TEXT NOT NULL REFERENCES import_batches(batch_id),
  UNIQUE(source_file_id, ordinal, raw_object_id)
);

CREATE INDEX IF NOT EXISTS raw_records_file_idx ON raw_records(source_file_id);
CREATE INDEX IF NOT EXISTS raw_records_native_idx ON raw_records(source_tool, native_id);

CREATE TABLE IF NOT EXISTS import_errors (
  error_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          TEXT NOT NULL REFERENCES import_batches(batch_id),
  source_file_id    TEXT,
  raw_record_id     TEXT,
  kind              TEXT NOT NULL,
  message           TEXT NOT NULL,
  payload_object_id TEXT REFERENCES objects(object_id),
  occurred_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uncertainties (
  uncertainty_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type        TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  reason             TEXT NOT NULL,
  metadata_object_id TEXT REFERENCES objects(object_id)
);

CREATE TABLE IF NOT EXISTS projects (
  project_id          TEXT PRIMARY KEY,
  canonical_path      TEXT,
  path_hash           TEXT,
  source_tool         TEXT,
  source_project_id   TEXT,
  display_name        TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE(source_tool, source_project_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT PRIMARY KEY,
  source_tool          TEXT NOT NULL,
  source_session_id    TEXT NOT NULL,
  project_id           TEXT REFERENCES projects(project_id),
  parent_session_id    TEXT REFERENCES sessions(session_id),
  is_subagent          INTEGER NOT NULL DEFAULT 0,
  agent_role           TEXT,
  agent_nickname       TEXT,
  title                TEXT,
  summary              TEXT,
  start_ts             TEXT,
  end_ts               TEXT,
  cwd_initial          TEXT,
  git_branch_initial   TEXT,
  model_first          TEXT,
  model_last           TEXT,
  status               TEXT,
  timeline_confidence  TEXT NOT NULL DEFAULT 'high'
                       CHECK (timeline_confidence IN ('high','medium','low')),
  raw_record_id        TEXT REFERENCES raw_records(raw_record_id),
  UNIQUE(source_tool, source_session_id)
);

CREATE INDEX IF NOT EXISTS sessions_source_idx ON sessions(source_tool);
CREATE INDEX IF NOT EXISTS sessions_start_idx ON sessions(start_ts);
CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions(project_id);
CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS turns (
  turn_id           TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(session_id),
  source_turn_id    TEXT,
  ordinal           INTEGER NOT NULL,
  start_ts          TEXT,
  end_ts            TEXT,
  model             TEXT,
  cwd               TEXT,
  git_branch        TEXT,
  approval_policy   TEXT,
  sandbox_policy    TEXT,
  effort            TEXT,
  raw_record_id     TEXT REFERENCES raw_records(raw_record_id)
);

CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id, ordinal);

CREATE TABLE IF NOT EXISTS events (
  event_id           TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(session_id),
  turn_id            TEXT REFERENCES turns(turn_id),
  source_event_id    TEXT,
  event_type         TEXT NOT NULL,
  source_type        TEXT,
  subtype            TEXT,
  timestamp          TEXT,
  ordinal            INTEGER NOT NULL,
  actor              TEXT,
  payload_object_id  TEXT REFERENCES objects(object_id),
  raw_record_id      TEXT NOT NULL REFERENCES raw_records(raw_record_id),
  confidence         TEXT NOT NULL DEFAULT 'high',
  is_derived         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id, ordinal);
CREATE INDEX IF NOT EXISTS events_type_idx ON events(event_type, subtype);

CREATE TABLE IF NOT EXISTS messages (
  message_id          TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  turn_id             TEXT REFERENCES turns(turn_id),
  event_id            TEXT REFERENCES events(event_id),
  source_message_id   TEXT,
  role                TEXT NOT NULL CHECK (role IN (
                        'system_prompt','developer','user','assistant','tool','operational'
                      )),
  author_name         TEXT,
  model               TEXT,
  timestamp           TEXT,
  ordinal             INTEGER NOT NULL,
  parent_message_id   TEXT REFERENCES messages(message_id),
  request_id          TEXT,
  status              TEXT,
  raw_record_id       TEXT NOT NULL REFERENCES raw_records(raw_record_id)
);

CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, ordinal);
CREATE INDEX IF NOT EXISTS messages_role_idx ON messages(role);

CREATE TABLE IF NOT EXISTS content_blocks (
  block_id        TEXT PRIMARY KEY,
  message_id      TEXT REFERENCES messages(message_id),
  event_id        TEXT REFERENCES events(event_id),
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  ordinal         INTEGER NOT NULL,
  block_type      TEXT NOT NULL,
  text_object_id  TEXT REFERENCES objects(object_id),
  text_inline     TEXT,
  mime_type       TEXT,
  token_count     INTEGER,
  is_error        INTEGER NOT NULL DEFAULT 0,
  is_redacted     INTEGER NOT NULL DEFAULT 0,
  visibility      TEXT NOT NULL DEFAULT 'default'
                  CHECK (visibility IN ('default','hidden_by_default','audit_only')),
  raw_record_id   TEXT NOT NULL REFERENCES raw_records(raw_record_id)
);

CREATE INDEX IF NOT EXISTS blocks_session_idx ON content_blocks(session_id, ordinal);
CREATE INDEX IF NOT EXISTS blocks_message_idx ON content_blocks(message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  tool_call_id          TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(session_id),
  turn_id               TEXT REFERENCES turns(turn_id),
  message_id            TEXT REFERENCES messages(message_id),
  event_id              TEXT REFERENCES events(event_id),
  source_call_id        TEXT,
  tool_name             TEXT NOT NULL,
  canonical_tool_type   TEXT,
  args_object_id        TEXT REFERENCES objects(object_id),
  command               TEXT,
  cwd                   TEXT,
  path                  TEXT,
  query                 TEXT,
  timestamp_start       TEXT,
  timestamp_end         TEXT,
  status                TEXT,
  raw_record_id         TEXT NOT NULL REFERENCES raw_records(raw_record_id)
);

CREATE INDEX IF NOT EXISTS tool_calls_session_idx ON tool_calls(session_id, timestamp_start);
CREATE INDEX IF NOT EXISTS tool_calls_name_idx ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS tool_calls_canon_idx ON tool_calls(canonical_tool_type);
CREATE INDEX IF NOT EXISTS tool_calls_source_call_idx ON tool_calls(session_id, source_call_id);

CREATE TABLE IF NOT EXISTS tool_results (
  tool_result_id        TEXT PRIMARY KEY,
  tool_call_id          TEXT REFERENCES tool_calls(tool_call_id),
  session_id            TEXT NOT NULL REFERENCES sessions(session_id),
  message_id            TEXT REFERENCES messages(message_id),
  event_id              TEXT REFERENCES events(event_id),
  source_call_id        TEXT,
  status                TEXT,
  is_error              INTEGER NOT NULL DEFAULT 0,
  exit_code             INTEGER,
  duration_ms           INTEGER,
  stdout_object_id      TEXT REFERENCES objects(object_id),
  stderr_object_id      TEXT REFERENCES objects(object_id),
  output_object_id      TEXT REFERENCES objects(object_id),
  preview               TEXT,
  raw_record_id         TEXT NOT NULL REFERENCES raw_records(raw_record_id)
);

CREATE INDEX IF NOT EXISTS tool_results_session_idx ON tool_results(session_id);
CREATE INDEX IF NOT EXISTS tool_results_call_idx ON tool_results(tool_call_id);
CREATE INDEX IF NOT EXISTS tool_results_source_call_idx ON tool_results(session_id, source_call_id);
CREATE INDEX IF NOT EXISTS tool_results_error_idx ON tool_results(is_error);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id     TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES sessions(session_id),
  project_id      TEXT REFERENCES projects(project_id),
  source_tool     TEXT NOT NULL,
  kind            TEXT NOT NULL,
  path            TEXT,
  logical_path    TEXT,
  object_id       TEXT REFERENCES objects(object_id),
  text_object_id  TEXT REFERENCES objects(object_id),
  mime_type       TEXT,
  size_bytes      INTEGER NOT NULL,
  created_ts      TEXT,
  raw_record_id   TEXT NOT NULL REFERENCES raw_records(raw_record_id)
);

CREATE INDEX IF NOT EXISTS artifacts_session_idx ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS artifacts_path_idx ON artifacts(path);

CREATE TABLE IF NOT EXISTS edges (
  edge_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  src_type             TEXT NOT NULL,
  src_id               TEXT NOT NULL,
  dst_type             TEXT NOT NULL,
  dst_id               TEXT NOT NULL,
  edge_type            TEXT NOT NULL,
  confidence           TEXT NOT NULL DEFAULT 'high',
  source               TEXT NOT NULL DEFAULT 'explicit',
  raw_record_id        TEXT REFERENCES raw_records(raw_record_id),
  metadata_object_id   TEXT REFERENCES objects(object_id),
  UNIQUE(src_type, src_id, dst_type, dst_id, edge_type)
);

CREATE INDEX IF NOT EXISTS edges_src_idx ON edges(src_type, src_id);
CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges(dst_type, dst_id);
CREATE INDEX IF NOT EXISTS edges_type_idx ON edges(edge_type);

CREATE TABLE IF NOT EXISTS search_docs (
  doc_id                TEXT PRIMARY KEY,
  entity_type           TEXT NOT NULL,
  entity_id             TEXT NOT NULL,
  session_id            TEXT,
  project_id            TEXT,
  timestamp             TEXT,
  role                  TEXT,
  tool_name             TEXT,
  canonical_tool_type   TEXT,
  field_kind            TEXT NOT NULL,
  text                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS search_docs_session_idx ON search_docs(session_id);
CREATE INDEX IF NOT EXISTS search_docs_entity_idx ON search_docs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS search_docs_field_idx ON search_docs(field_kind);

CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts USING fts5(
  text,
  role            UNINDEXED,
  tool_name       UNINDEXED,
  field_kind      UNINDEXED,
  content='search_docs',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_docs_fts(rowid, text, role, tool_name, field_kind)
  VALUES (new.rowid, new.text, new.role, new.tool_name, new.field_kind);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_docs_fts(search_docs_fts, rowid, text, role, tool_name, field_kind)
  VALUES('delete', old.rowid, old.text, old.role, old.tool_name, old.field_kind);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_docs_fts(search_docs_fts, rowid, text, role, tool_name, field_kind)
  VALUES('delete', old.rowid, old.text, old.role, old.tool_name, old.field_kind);
  INSERT INTO search_docs_fts(rowid, text, role, tool_name, field_kind)
  VALUES (new.rowid, new.text, new.role, new.tool_name, new.field_kind);
END;
`
