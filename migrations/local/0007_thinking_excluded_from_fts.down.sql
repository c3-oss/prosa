-- Restore the unconditional AI/AD triggers from 0001_init.
DROP TRIGGER IF EXISTS turns_ai;
DROP TRIGGER IF EXISTS turns_ad;

CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, role, content) VALUES (new.id, new.role, new.content);
END;

CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, role, content) VALUES('delete', old.id, old.role, old.content);
END;
