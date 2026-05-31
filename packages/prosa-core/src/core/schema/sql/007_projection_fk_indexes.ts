// Loaded at runtime by core/schema/migrate.ts.

/** Add indexes used by projection FK checks during in-place reimports. */
export const SQL_007_PROJECTION_FK_INDEXES = String.raw`
-- Schema W v7

CREATE INDEX IF NOT EXISTS messages_event_idx ON messages(event_id);
CREATE INDEX IF NOT EXISTS blocks_event_idx ON content_blocks(event_id);
CREATE INDEX IF NOT EXISTS tool_calls_message_idx ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS tool_calls_event_idx ON tool_calls(event_id);
CREATE INDEX IF NOT EXISTS tool_results_message_idx ON tool_results(message_id);
CREATE INDEX IF NOT EXISTS tool_results_event_idx ON tool_results(event_id);
`
