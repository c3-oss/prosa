ALTER TABLE sessions ADD COLUMN request_coverage TEXT NOT NULL DEFAULT 'none';
ALTER TABLE sessions ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET projection_version = sync_state.projection_version
FROM sync_state WHERE sync_state.session_id = sessions.id;

CREATE TABLE session_requests (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (session_id, ordinal)
);
