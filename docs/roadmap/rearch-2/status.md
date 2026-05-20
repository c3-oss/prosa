# rearch-2 Current Status

Updated: 2026-05-20 after Parquet compaction merge worker landed.

## Summary

- Lane 0 Foundation: **accepted**.
- Lane 1 Local store: **accepted** with recorded rescopes.
- Lane 2 Importers: **accepted** by Codex/governor on 2026-05-19.
- Lane 3 Derived layer: **active / incomplete**.
- Lane 4 Server: **not yet started for delivery**; only early db scaffold exists.
- Lanes 5–10: **not started**.

## Current Lane 3 focus

CQ-115 closed. Tantivy runtime + bundle orchestrator + CLI shipped. The
governor-mandated Tantivy compile-to-index gate is now satisfied end-to-end:
`apps/cli/test/cli/compile-to-index-gate.test.ts` spawns `compile-v2 codex`
against a fixture, then `index-v2 tantivy`, then `index-v2 status`, and asserts
`tantivy.ready_for_read === true` with `indexed_doc_count === source_doc_count`.
The v2 codex importer now emits one search_doc per message with indexable text;
full v1 parity for tool-call / tool-result fan-out remains a follow-up.

Remaining runtime executor slices:

1. DuckDB analytics runtime executor review/acceptance for `828b59f`.
2. Per-provider search_doc emission parity (claude / cursor / gemini / hermes) so the compile-to-index gate covers every importer.
3. Lane-3 gate wiring and end-to-end validation.

Do **not** add more pure-read/audit/CLI surfaces unless they are directly required to implement or validate one of those runtime executors.

## Important correction

The prior claim that the Lane 3 runtime executors were blocked by `pnpm-workspace.yaml` `allowBuilds` was wrong. Direct smoke tests showed both native dependencies are runtime-available:

- `@duckdb/node-api` can create an in-memory DB and run `SELECT 42`.
- `@oxdev03/node-tantivy-binding` can build a schema.

The blocker is implementation work, not environment.

## Open blockers

No open correction-queue blockers are currently recorded. CQ-115 closed 2026-05-20 — see `correction-queue.md` for the closure record.

## Supporting documents

- Source plan: `docs/rearch-2/`.
- Consolidated handoff: `docs/roadmap/rearch-2/cycle-reset-2026-05-19.md`.
- Current gates: `docs/roadmap/rearch-2/gates.md`.
- Current lane evidence: `docs/roadmap/rearch-2/evidence/`.
