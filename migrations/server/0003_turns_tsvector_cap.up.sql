-- Postgres' tsvector caps a single document at ~1 MiB. A handful of
-- prosa sessions emit turns whose `content` exceeds that (tool outputs,
-- huge paste-ins) and the original GENERATED expression
-- `to_tsvector('simple', content)` rejects the INSERT with
-- "string is too long for tsvector". The session metadata + raw bytes
-- are fine; only the FTS column blew up.
--
-- Fix: drop the column and re-add it indexing only the first 800 KB of
-- `content`. The full body remains intact in `turns.content`, so Get
-- responses and the panel still show everything; only the FTS index
-- skips the overflow tail. 800 KB leaves a safe margin under the 1 MiB
-- ceiling without losing useful body for any realistic prompt or reply.
ALTER TABLE turns DROP COLUMN content_tsv;
ALTER TABLE turns ADD COLUMN content_tsv TSVECTOR GENERATED ALWAYS AS
  (to_tsvector('simple', left(content, 800000))) STORED;
CREATE INDEX IF NOT EXISTS idx_turns_content_tsv ON turns USING GIN(content_tsv);
