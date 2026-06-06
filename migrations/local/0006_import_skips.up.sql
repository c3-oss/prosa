-- import_skips remembers policy skips for files that should not create or
-- update a sessions row. session_id may be either a real sessions.id
-- (reason='no_usage') or a synthetic marker id (reason='state_seen', e.g.
-- 'hermes-state-<hash[:12]>'). There is intentionally no FK to sessions.
CREATE TABLE import_skips (
  session_id         TEXT NOT NULL,
  reason             TEXT NOT NULL,
  last_hash          TEXT NOT NULL,
  skipped_at         TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  PRIMARY KEY (session_id, reason)
);
