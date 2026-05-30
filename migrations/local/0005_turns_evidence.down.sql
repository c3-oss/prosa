DROP INDEX IF EXISTS idx_turns_tool_name;
DROP INDEX IF EXISTS idx_turns_kind;
ALTER TABLE turns DROP COLUMN tool_name;
ALTER TABLE turns DROP COLUMN kind;
