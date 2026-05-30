CREATE TABLE session_usage (
  session_id            TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  total_tokens          BIGINT NOT NULL DEFAULT 0,
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  cached_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE sync_state ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 1;
