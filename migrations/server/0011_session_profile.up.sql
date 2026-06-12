-- Mirror of local 0009: per-agent, per-device profile pushed by the client.
ALTER TABLE sessions ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS sessions_profile_idx ON sessions(device_id, agent, profile);
