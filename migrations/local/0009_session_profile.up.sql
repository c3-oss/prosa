-- Per-agent, per-device profile each session was imported from.
ALTER TABLE sessions ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_sessions_profile ON sessions(device_id, agent, profile);
