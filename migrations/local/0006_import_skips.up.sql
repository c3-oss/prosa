CREATE TABLE import_skips (
  session_id         TEXT NOT NULL,
  reason             TEXT NOT NULL,
  last_hash          TEXT NOT NULL,
  skipped_at         TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  PRIMARY KEY (session_id, reason)
);
