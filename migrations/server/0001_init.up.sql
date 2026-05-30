-- Server-side schema. Mirrors the canonical fields of the local SQLite
-- schema (migrations/local/0001 + 0002) but uses Postgres-native types
-- (TIMESTAMPTZ, BIGSERIAL, TSVECTOR + GIN) and adds the auth surface
-- (device_codes, device_tokens) that the CLI exercises via AuthService.

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE devices (
  id               TEXT PRIMARY KEY,
  hostname         TEXT NOT NULL,
  machine_id       TEXT NOT NULL,
  friendly_name    TEXT NOT NULL,
  fingerprinted_at TIMESTAMPTZ NOT NULL,
  last_sync        TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ
);
CREATE INDEX devices_revoked_idx ON devices(revoked_at);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  agent            TEXT NOT NULL,
  device_id        TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  project_path     TEXT,
  project_remote   TEXT,
  project_marker   TEXT,
  started_at       TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  first_prompt     TEXT,
  model            TEXT,
  raw_uri          TEXT NOT NULL,
  raw_hash         TEXT NOT NULL,
  raw_size         BIGINT NOT NULL
);
CREATE INDEX sessions_device_started_idx ON sessions(device_id, started_at DESC);
CREATE INDEX sessions_started_idx        ON sessions(started_at DESC);
CREATE INDEX sessions_project_remote_idx ON sessions(project_remote);
CREATE INDEX sessions_project_marker_idx ON sessions(project_marker);
CREATE INDEX sessions_agent_idx          ON sessions(agent);

CREATE TABLE session_tools (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  count      INTEGER NOT NULL,
  PRIMARY KEY (session_id, name)
);
CREATE INDEX session_tools_name_idx ON session_tools(name);

CREATE TABLE turns (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX turns_session_idx     ON turns(session_id);
CREATE INDEX turns_content_tsv_idx ON turns USING GIN(content_tsv);

CREATE TABLE sync_state (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_hash      TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL
);

-- Auth surfaces (Group B). device_codes is the short-lived PENDING/APPROVED
-- state table; device_tokens stores only sha256(token) so a leaked DB can't
-- impersonate a device.
CREATE TABLE device_codes (
  device_code TEXT PRIMARY KEY,
  user_code   TEXT UNIQUE NOT NULL,
  state       TEXT NOT NULL,
  hostname    TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ
);
CREATE INDEX device_codes_expires_idx ON device_codes(expires_at);

CREATE TABLE device_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX device_tokens_device_idx ON device_tokens(device_id);
