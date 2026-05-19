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

export * from './bundle-status.js'
export * from './derived-layout.js'
export * from './session-blob/types.js'
export * from './session-blob/writer-policy.js'
export * from './session-blob/framing.js'
export * from './session-blob/writer.js'
export * from './session-blob/reader.js'
export * from './session-blob/containment.js'
export * from './session-blob/exists.js'
export * from './session-blob/listing.js'
export * from './session-blob/header.js'
export * from './session-blob/latest-epoch.js'
export * from './session-blob/latest.js'
export * from './session-blob/summary.js'
export * from './session-blob/transcript-from-bundle.js'
export * from './session-blob/loader.js'
export * from './session-blob/zstd.js'
export * from './session-blob/projection-bridge.js'
export * from './compaction/policy.js'
export * from './compaction/planner.js'
export * from './compaction/executor-plan.js'
export * from './analytics/descriptor.js'
export * from './analytics/views.js'
export * from './analytics/executor-plan.js'
export * from './tantivy/schema.js'
export * from './tantivy/status.js'
export * from './tantivy/rebuild-plan.js'
export * from './tantivy/checkpoint-store.js'
export * from './tantivy/index-dir.js'
export * from './tantivy/plan-bundle.js'
