# rearch-2 Current Status

Updated: 2026-05-20 after Tantivy runtime + bundle orchestrator landed.

## Summary

- Lane 0 Foundation: **accepted**.
- Lane 1 Local store: **accepted** with recorded rescopes.
- Lane 2 Importers: **accepted** by Codex/governor on 2026-05-19.
- Lane 3 Derived layer: **active / incomplete**.
- Lane 4 Server: **not yet started for delivery**; only early db scaffold exists.
- Lanes 5–10: **not started**.

## Current Lane 3 focus

Next slice is wiring the bundle orchestrator (`runTantivyRebuildForBundle`) into the `prosa index-v2 tantivy` CLI command and adding a scripted-bundle gate (`compile-v2 && index-v2 tantivy && index-v2 status`). After that:

1. `prosa index-v2 tantivy` CLI wiring + scripted-bundle gate proving `indexed_doc_count == source_doc_count` after `compile-v2 && index-v2 tantivy`.
2. DuckDB analytics runtime executor.
3. Parquet compaction merge worker.
4. Lane-3 gate wiring and end-to-end validation.

Do **not** add more pure-read/audit/CLI surfaces unless they are directly required to implement or validate one of those runtime executors.

## Important correction

The prior claim that the Lane 3 runtime executors were blocked by `pnpm-workspace.yaml` `allowBuilds` was wrong. Direct smoke tests showed both native dependencies are runtime-available:

- `@duckdb/node-api` can create an in-memory DB and run `SELECT 42`.
- `@oxdev03/node-tantivy-binding` can build a schema.

The blocker is implementation work, not environment.

## Open blockers

No open correction-queue blockers are currently recorded. The primary blocker is missing implementation for the Lane 3 runtime executors.

## Supporting documents

- Source plan: `docs/rearch-2/`.
- Consolidated handoff: `docs/roadmap/rearch-2/cycle-reset-2026-05-19.md`.
- Current gates: `docs/roadmap/rearch-2/gates.md`.
- Current lane evidence: `docs/roadmap/rearch-2/evidence/`.
