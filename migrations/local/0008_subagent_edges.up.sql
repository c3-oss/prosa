-- Subagent edge. Claude Code spawns its `Agent` tool as a sibling
-- JSONL inside `<parent-session-id>/subagents/agent-<uuid>.jsonl`,
-- and Codex records `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`
-- on each child session. Capture the relationship as a single
-- nullable column on `sessions` so the panel can walk parent→child
-- without a join table.
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;
