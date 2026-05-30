-- Composite index used by the catch-up reconcile path: paged scans of
-- "every session for a given device, ordered by id ASC" so the cursor
-- can be a plain `WHERE id > $after` without sorting the table at
-- query time.
CREATE INDEX IF NOT EXISTS idx_sessions_device_id ON sessions(device_id, id);
