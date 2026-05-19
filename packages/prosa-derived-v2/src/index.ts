// `@c3-oss/prosa-derived-v2` — Bundle v2 derived layer (Lane 3).
//
// This package owns the local derived artifacts that v2 read paths
// consume. The public surface is organised into four subsystems plus
// shared layout + top-level aggregator:
//
// Layout (`derived-layout`, `bundle-status`):
//
//   - `derivedPaths`, `derivedRoot` — typed on-disk path layout for
//     `<bundleRoot>/derived/`.
//   - `sessionBlobEpochDir`, `sessionBlobPackPath` — canonical
//     `derived/session-blob/epoch-<n>/<session_id>.pack` resolver
//     with input validation (CQ-099/CQ-100 path-traversal guards).
//   - `bundleDerivedStatus(bundleRoot)` — one-call read-only
//     snapshot composing Tantivy + SessionBlob + epoch listing.
//
// SessionBlob (`session-blob/*`):
//
//   - Byte layout: `writeSessionBlobPack`, `decodeSessionBlobPack`,
//     `loadTranscriptPage`, `iterateTranscript`, `loadTranscript`,
//     `verifyPackDigest`, plus identity + production zstd codecs
//     (`zstdSessionBlobCompressor` / `zstdSessionBlobDecompressor`).
//   - Joint-constraint policy: `decideBlock`, `decideMessageBoundary`
//     (1 MiB page, 32 KiB inline block, 256 hard / 128 target
//     messages/page).
//   - Projection bridge: `projectionToSessionBlobInputs`
//     (canonical projection → writer input shape).
//   - Pack I/O: `loadSessionBlobPack`, `loadLatestSessionBlobPack`,
//     `readSessionBlobHeader`, `sessionBlobPackExists` (cheap
//     existence probe), `latestEpochForSession`.
//   - Listing: `listSessionBlobEpochs`,
//     `listSessionBlobSessions`, `listAllSessionBlobSessions`.
//   - Transcript end-to-end: `loadTranscriptFromBundle` (collect-
//     all), `iterateTranscriptFromBundle` (streaming generator).
//   - Inventory: `getSessionBlobSummary`, `listSessionBlobSummaries`.
//   - Containment: `detectSessionBlobIntermediateSymlink` (shared
//     CQ-098 helper used by every SessionBlob surface).
//
// Tantivy (`tantivy/*`):
//
//   - Schema: `TANTIVY_SCHEMA_FIELDS`, `currentTantivySchemaFingerprint`,
//     `toTantivyFieldMap`.
//   - Rebuild-plan state machine: `IndexCheckpointV2`,
//     `planTantivyRebuild`, `planTantivyRebuildFromBundle`,
//     `checkpointAfterRebuild`, `checkpointAfterFailure`.
//   - Checkpoint persistence: `readIndexCheckpoint`,
//     `readIndexCheckpointOrEmpty`, `writeIndexCheckpoint`
//     (CQ-093 rename-based atomic write).
//   - Index dir: `tantivyIndexDir`, `tantivyMetaPath`,
//     `tantivyIndexDirIsValid` (CQ-094 final-component + CQ-096
//     intermediate symlink rejection), `clearTantivyIndexDir`.
//   - Status: `tantivyIndexStatus` (top-level read-only snapshot
//     aggregating checkpoint + dir probe + fingerprint).
//
// Analytics (`analytics/*`):
//
//   - View shape contract: `ANALYTICS_VIEW_NAMES`,
//     `ANALYTICS_VIEW_COLUMNS`, `ANALYTICS_ENTITY_TABLES`,
//     `analyticsViewSql`, `parquetReadFor`, `analyticsParquetPreamble`.
//   - Catalog: `analyticsViewDescriptor`, `analyticsViewsDescriptor`
//     (per-view + bulk { name, columns, sql } shape for MCP /
//     CLI consumers).
//   - Execution: `planAnalyticsExecution` (composes the DuckDB
//     statement sequence the runtime executor consumes).
//
// Compaction (`compaction/*`):
//
//   - Trigger policy: `compactionDecision` (>32 small files OR
//     16<count<=32 small files <256 MiB).
//   - Planner: `planCompaction` (groups segments by entity, applies
//     the policy, emits deterministic per-entity plans). Routes
//     through `listProjectionSegments` for CQ-101 containment.
//   - Execution: `planCompactionExecution` (turns a CompactionPlan
//     into the ordered DuckDB COPY statement sequence).
//   - Segment listing: `listProjectionSegments`,
//     `summariseProjectionSegments` (CQ-094/CQ-096-parallel
//     containment for the `epochs/` tree).
//
// Pure read paths everywhere — no native bindings, no DuckDB
// connection management. The Tantivy native writer and the runtime
// DuckDB executor land separately once `@oxdev03/node-tantivy-binding`
// and `@duckdb/node-api` enter `pnpm-workspace.yaml`'s `allowBuilds`.

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
export * from './session-blob/transcript-format-markdown.js'
export * from './session-blob/transcript-format-text.js'
export * from './session-blob/transcript-from-bundle.js'
export * from './session-blob/verify-all.js'
export * from './session-blob/loader.js'
export * from './session-blob/zstd.js'
export * from './session-blob/projection-bridge.js'
export * from './compaction/policy.js'
export * from './compaction/planner.js'
export * from './compaction/segments.js'
export * from './compaction/executor-plan.js'
export * from './compaction/manifest.js'
export * from './compaction/superseded.js'
export * from './analytics/descriptor.js'
export * from './analytics/views.js'
export * from './analytics/executor-plan.js'
export * from './tantivy/schema.js'
export * from './tantivy/status.js'
export * from './tantivy/rebuild-plan.js'
export * from './tantivy/checkpoint-store.js'
export * from './tantivy/index-dir.js'
export * from './tantivy/plan-bundle.js'
