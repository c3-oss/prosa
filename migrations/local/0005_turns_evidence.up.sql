-- Turn evidence metadata. `kind` lets the renderer and the search hit
-- distinguish chat messages from projected tool outputs without a
-- second JOIN; `tool_name` carries the originating tool (Bash, exec,
-- apply_patch, etc.) when known. Both default to safe values so
-- existing rows keep working before importers backfill them.
ALTER TABLE turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE turns ADD COLUMN tool_name TEXT;

CREATE INDEX idx_turns_kind ON turns(kind);
CREATE INDEX idx_turns_tool_name ON turns(tool_name) WHERE tool_name IS NOT NULL;
