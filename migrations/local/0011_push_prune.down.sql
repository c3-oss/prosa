DROP INDEX IF EXISTS idx_sessions_pruned;
ALTER TABLE sessions DROP COLUMN pruned_at;
ALTER TABLE sync_state DROP COLUMN remote_uri;
ALTER TABLE sync_state DROP COLUMN pushed_hash;
ALTER TABLE sync_state DROP COLUMN pushed_at;
