// Adds the checkpoint columns that let `rebuildTantivyIndex` run
// incrementally instead of dropping the on-disk index every compile.
//
// - `last_indexed_rowid` is the highest `search_docs.rowid` already in the
//   Tantivy segments. The rebuild path SELECTs `WHERE rowid > last_indexed_rowid`
//   on incremental runs.
// - `schema_fingerprint` is a deterministic hash of the schema definition.
//   When the code-time fingerprint and the persisted fingerprint disagree
//   the next rebuild falls back to a full re-index.
//
// Both columns are nullable. Bundles upgraded from v3 inherit NULL, which
// the rebuild path treats as "force full rebuild" — the safe default.

export const SQL_004_TANTIVY_CHECKPOINT = String.raw`
ALTER TABLE search_index_status ADD COLUMN last_indexed_rowid INTEGER;
ALTER TABLE search_index_status ADD COLUMN schema_fingerprint TEXT;
`
