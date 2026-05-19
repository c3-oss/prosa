// `@c3-oss/prosa-derived-v2` — Bundle v2 derived layer (Lane 3).
//
// This package owns the local derived artifacts that v2 read paths
// consume:
//
//   - SessionBlobPackV2 paged transcript packs (writer + reader).
//   - Tantivy full-text index (local only; Postgres FTS handles
//     remote in Lane 4).
//   - DuckDB analytics view definitions over Parquet projection
//     segments.
//   - Parquet compaction worker.
//
// The first iteration ships the paged-pack joint-constraint policy
// and the Parquet compaction trigger policy as pure-TypeScript
// modules; the Tantivy writer, DuckDB views, and the SessionBlob
// pack-format byte layout land in follow-up commits.

export * from './session-blob/types.js'
export * from './session-blob/writer-policy.js'
export * from './compaction/policy.js'
