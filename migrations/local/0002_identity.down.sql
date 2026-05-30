DROP INDEX IF EXISTS idx_sessions_project_remote;
DROP INDEX IF EXISTS idx_sessions_project_marker;
ALTER TABLE sessions DROP COLUMN project_remote;
ALTER TABLE sessions DROP COLUMN project_marker;
ALTER TABLE devices  DROP COLUMN fingerprinted_at;
