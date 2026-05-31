-- Subagent edge. Mirror of local 0008. Captures Claude Code's
-- subagent-as-sibling-jsonl and Codex's thread_spawn.parent_thread_id
-- on each child session so the panel can walk parent→child without
-- joining on a separate table.
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_parent
  ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;
