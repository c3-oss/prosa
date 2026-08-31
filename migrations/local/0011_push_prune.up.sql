-- Push state: what the server has confirmed holding for this session.
-- Written on successful (or idempotent) Push; backfilled from the server
-- manifest during reconcile for sessions pushed before these columns existed.
ALTER TABLE sync_state ADD COLUMN pushed_at   TEXT;
ALTER TABLE sync_state ADD COLUMN pushed_hash TEXT;
ALTER TABLE sync_state ADD COLUMN remote_uri  TEXT;

-- Pruned: the local raw copy was deleted after the server confirmed it holds
-- the same raw_hash. Turns/FTS/usage stay local; raw reads stream from the
-- server via SessionsService.GetRaw.
ALTER TABLE sessions ADD COLUMN pruned_at TEXT;
CREATE INDEX idx_sessions_pruned ON sessions(pruned_at) WHERE pruned_at IS NOT NULL;
