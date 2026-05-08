# Incremental Parquet Export

## Goal

Reduce the cost of refreshing Parquet exports by avoiding full rewrites when a
compile imports only a small delta.

## Current State

The current export model rewrites every canonical table every time Parquet is
rebuilt. The import pipeline docs explicitly call this out as acceptable while
bundle sizes stay in the gigabyte range.

## Proposed Direction

Track enough export state to decide which tables or partitions need to be
refreshed after an import batch. The first useful step is not necessarily true
append-only Parquet; a table-level dirty check may be enough.

Possible levels:

- Table-level dirty tracking: rewrite only tables whose row count or max import
  batch changed.
- Batch-partitioned exports: write files partitioned by `import_batch_id` or
  source tool where the schema supports it.
- Manifest-driven snapshots: record file sets, row counts, schema version, and
  source batch range in the manifest.

## Implementation Notes

Do not make Parquet authoritative. If export state is missing or inconsistent,
fall back to a full rebuild.

The manifest should become the coordination point. It can record schema version,
parser version, exported table files, row counts, and enough source watermarks to
decide whether an incremental refresh is valid.

## Acceptance Criteria

- Full rebuild remains available and is the correctness fallback.
- Re-running compile with no imported rows does not refresh Parquet.
- A small import delta refreshes less work than a full rebuild in the common
  case.
- Tests cover stale manifests, schema changes, and fallback behavior.

## Risks

Incremental export adds complexity around deletes, schema migrations, and
idempotent re-imports. It should wait until full rebuild cost is clearly visible
in real stores.

