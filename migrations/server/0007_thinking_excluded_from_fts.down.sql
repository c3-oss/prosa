-- Restore the unconditional content_tsv definition from 0003.
ALTER TABLE turns DROP COLUMN content_tsv;
ALTER TABLE turns ADD COLUMN content_tsv TSVECTOR GENERATED ALWAYS AS
  (to_tsvector('simple', left(content, 800000))) STORED;
CREATE INDEX IF NOT EXISTS idx_turns_content_tsv ON turns USING GIN(content_tsv);
