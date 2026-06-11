-- Per-agent, per-device profile. A profile is a configured location for an
-- agent on this device (e.g. an alternate CODEX_HOME holding a second
-- authenticated account). Each session records the profile it was imported
-- from as a stable, cross-device name; the name→path mapping itself lives in
-- the local profiles.json config, not the database. Existing rows default to
-- 'default', preserving today's single-location behaviour.
ALTER TABLE sessions ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_sessions_profile ON sessions(device_id, agent, profile);
