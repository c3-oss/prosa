/**
 * Adds checkpoint columns for incremental Tantivy rebuilds.
 *
 * `last_indexed_rowid` is the highest `search_docs.rowid` already present in
 * Tantivy segments. `schema_fingerprint` lets the rebuild path detect index
 * schema changes and fall back to a full re-index. Both columns are nullable;
 * upgraded v3 bundles therefore default to the safe full-rebuild behavior.
 */
export const SQL_004_TANTIVY_CHECKPOINT = String.raw`
ALTER TABLE search_index_status ADD COLUMN last_indexed_rowid INTEGER;
ALTER TABLE search_index_status ADD COLUMN schema_fingerprint TEXT;
`
