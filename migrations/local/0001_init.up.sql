CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  hostname      TEXT NOT NULL,
  machine_id    TEXT NOT NULL,
  friendly_name TEXT NOT NULL
);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  agent            TEXT NOT NULL,
  device_id        TEXT NOT NULL REFERENCES devices(id),
  project_path     TEXT,
  started_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  first_prompt     TEXT,
  model            TEXT,
  raw_path         TEXT NOT NULL,
  raw_hash         TEXT NOT NULL,
  raw_size         INTEGER NOT NULL
);
CREATE INDEX idx_sessions_started_at    ON sessions(started_at DESC);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at DESC);
CREATE INDEX idx_sessions_project       ON sessions(project_path);
CREATE INDEX idx_sessions_agent         ON sessions(agent);

CREATE TABLE session_tools (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  count      INTEGER NOT NULL,
  PRIMARY KEY (session_id, name)
);
CREATE INDEX idx_session_tools_name ON session_tools(name);

CREATE TABLE turns (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  ts         TEXT NOT NULL
);
CREATE INDEX idx_turns_session ON turns(session_id);

CREATE VIRTUAL TABLE turns_fts USING fts5(
  role, content,
  content='turns', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, role, content) VALUES (new.id, new.role, new.content);
END;
CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, role, content) VALUES('delete', old.id, old.role, old.content);
END;

CREATE TABLE sync_state (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_hash      TEXT NOT NULL,
  last_synced_at TEXT NOT NULL
);

INSERT INTO devices(id, hostname, machine_id, friendly_name)
VALUES ('local', '', '', 'local');
