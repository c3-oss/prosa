-- Thinking blocks (Claude Code's extended-thinking content,
-- Codex reasoning.summary) land in `turns` with kind='thinking' as
-- of projection v7. They are reasoning preview, not chat content,
-- and should not pollute FTS search results — recreate the AI/AD
-- triggers with a WHEN guard so thinking rows never enter turns_fts.
-- Pre-existing thinking rows (none, since v7 is the first to emit
-- this kind) would be unaffected.

DROP TRIGGER IF EXISTS turns_ai;
DROP TRIGGER IF EXISTS turns_ad;

CREATE TRIGGER turns_ai AFTER INSERT ON turns
  WHEN new.kind != 'thinking'
BEGIN
  INSERT INTO turns_fts(rowid, role, content) VALUES (new.id, new.role, new.content);
END;

CREATE TRIGGER turns_ad AFTER DELETE ON turns
  WHEN old.kind != 'thinking'
BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, role, content) VALUES('delete', old.id, old.role, old.content);
END;
