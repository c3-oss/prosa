export const SQL_002_SEARCH_INDEX_STATUS = String.raw`
CREATE TABLE IF NOT EXISTS search_index_status (
  engine                 TEXT PRIMARY KEY,
  status                 TEXT NOT NULL CHECK (status IN ('missing','ready','stale','building','failed')),
  source_doc_count        INTEGER NOT NULL DEFAULT 0,
  indexed_doc_count       INTEGER NOT NULL DEFAULT 0,
  updated_at              TEXT NOT NULL,
  error_message           TEXT
);

INSERT OR IGNORE INTO search_index_status (
  engine, status, source_doc_count, indexed_doc_count, updated_at, error_message
) VALUES
  ('fts5', 'ready', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('tantivy', 'missing', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL);
`
