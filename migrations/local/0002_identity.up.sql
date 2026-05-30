-- Project identity beyond raw cwd. project_remote holds the canonical
-- `git remote get-url origin` URL when resolvable; project_marker holds
-- the `project:` value from a .prosa.yaml file in the session's cwd or
-- an ancestor. Both are NULL on rows whose cwd is no longer reachable
-- (e.g. legacy bundle restores from a different machine).
ALTER TABLE sessions ADD COLUMN project_remote TEXT;
ALTER TABLE sessions ADD COLUMN project_marker TEXT;
CREATE INDEX idx_sessions_project_remote ON sessions(project_remote);
CREATE INDEX idx_sessions_project_marker ON sessions(project_marker);

-- Track when each device row was first or last fingerprinted. NULL on
-- the seed `'local'` row from 0001; populated by `prosa sync` on machines
-- that have run the new device package.
ALTER TABLE devices ADD COLUMN fingerprinted_at TEXT;
