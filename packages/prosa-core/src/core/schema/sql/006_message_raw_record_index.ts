// Loaded at runtime by core/schema/migrate.ts.

/** Add an index used when resolving source raw records back to messages. */
export const SQL_006_MESSAGE_RAW_RECORD_INDEX = String.raw`
-- Schema W v6

CREATE INDEX IF NOT EXISTS messages_raw_record_idx ON messages(raw_record_id);
`
