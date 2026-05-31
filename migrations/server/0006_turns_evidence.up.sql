-- Turn evidence metadata. Mirrors local 0005: kind tags the projected
-- shape (message / tool_result / operational) and tool_name carries
-- the originating tool when known. Both default to safe values so
-- existing rows survive the upgrade; importers backfill them on the
-- next push because projection_version was bumped.
ALTER TABLE turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE turns ADD COLUMN tool_name TEXT;

CREATE INDEX idx_turns_kind ON turns(kind);
CREATE INDEX idx_turns_tool_name ON turns(tool_name) WHERE tool_name IS NOT NULL;
