-- Composite index for the SessionsService.Manifest paginated cursor:
-- "every session for a given device, ordered by id ASC". Lets the
-- handler do `WHERE device_id = $1 AND id > $2 ORDER BY id LIMIT $3`
-- as an index-only scan.
CREATE INDEX IF NOT EXISTS idx_sessions_device_id ON sessions(device_id, id);
