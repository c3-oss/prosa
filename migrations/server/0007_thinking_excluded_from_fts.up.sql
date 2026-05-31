-- Thinking blocks (Claude Code's extended-thinking content,
-- Codex reasoning.summary) land in `turns` with kind='thinking' as
-- of projection v7. They are reasoning preview, not chat content,
-- and should not pollute FTS search results. Recompute the generated
-- content_tsv column with a CASE so thinking rows index an empty
-- tsvector; the GIN index keeps working unchanged.
ALTER TABLE turns DROP COLUMN content_tsv;
ALTER TABLE turns ADD COLUMN content_tsv TSVECTOR GENERATED ALWAYS AS (
  CASE WHEN kind = 'thinking' THEN to_tsvector('simple', '')
       ELSE to_tsvector('simple', left(content, 800000))
  END
) STORED;
CREATE INDEX IF NOT EXISTS idx_turns_content_tsv ON turns USING GIN(content_tsv);
