CREATE TABLE session_kinds (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  PRIMARY KEY (session_id, kind)
);
CREATE INDEX session_kinds_kind_idx ON session_kinds(kind);
