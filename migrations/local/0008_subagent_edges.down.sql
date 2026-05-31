DROP INDEX IF EXISTS idx_sessions_parent;
ALTER TABLE sessions DROP COLUMN parent_session_id;
