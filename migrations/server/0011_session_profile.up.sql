-- Mirror of local 0009. Records the per-agent, per-device profile each
-- session was imported from. The name is pushed by the client; the
-- name→path mapping stays local to each device. Existing rows default to
-- 'default'.
ALTER TABLE sessions ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS sessions_profile_idx ON sessions(device_id, agent, profile);
