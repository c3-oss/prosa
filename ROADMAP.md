# Roadmap

This roadmap tracks larger product and architecture directions that are not
ready to be treated as implementation specs. Each item links to a focused note
under `docs/roadmap/`.

## Parquet and Analytics

Parquet is currently a derived analytics snapshot of the canonical SQLite/CAS
bundle. The items below keep that contract: SQLite and CAS remain the source of
truth, while Parquet and DuckDB become more useful for scans, aggregation,
sharing, and external analysis.

| Item | Status | Document |
|---|---|---|
| Analytics views | Initial implementation | [`docs/roadmap/analytics-views.md`](./docs/roadmap/analytics-views.md) |
| Analytics commands | Initial implementation | [`docs/roadmap/analytics-commands.md`](./docs/roadmap/analytics-commands.md) |
| Parquet export performance (zstd-1 + row group) | Implemented | [`docs/roadmap/parquet-export-perf.md`](./docs/roadmap/parquet-export-perf.md) |
| Incremental Parquet export | Proposed | [`docs/roadmap/incremental-parquet-export.md`](./docs/roadmap/incremental-parquet-export.md) |
| BI-friendly datasets | Proposed | [`docs/roadmap/bi-friendly-datasets.md`](./docs/roadmap/bi-friendly-datasets.md) |
| Query recipes | Initial implementation | [`docs/roadmap/query-recipes.md`](./docs/roadmap/query-recipes.md) |
| Sanitized Parquet exports | Proposed | [`docs/roadmap/sanitized-parquet-exports.md`](./docs/roadmap/sanitized-parquet-exports.md) |

## Search Indexing

| Item | Status | Document |
|---|---|---|
| Tantivy multi-thread + incremental indexing | Implemented | [`docs/roadmap/tantivy-indexing-perf.md`](./docs/roadmap/tantivy-indexing-perf.md) |

## Priority Shape

1. Start with query recipes and analytics views. They improve the current
   Parquet surface without changing storage contracts.
2. Add analytics commands once the useful queries stabilize.
3. Add sanitized exports before encouraging broader sharing of Parquet bundles.
4. Add BI-friendly derived datasets when external analysis workflows need fewer
   joins.
5. Add incremental export only when full rebuild cost becomes a real problem.
