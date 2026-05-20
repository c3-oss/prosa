# rearch-2 Current Status

Updated: 2026-05-20 after CQ-118 closure was governor-accepted.

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
full v1 parity for tool-call / tool-result fan-out remains a follow-up. Reviewer
feedback says the gate should still be strengthened before Lane 3 finalization
by parsing the emitted `search_doc` row and/or querying the Tantivy index for the
fixture text/doc_id; this does not reopen CQ-115.

Current explicit milestone:

1. Fix CQ-117: post-compaction consumer visibility must not double-count rows.
   WIP exists in `packages/prosa-derived-v2/src/analytics/runtime-executor.ts`
   and `packages/prosa-derived-v2/src/compaction/runtime-worker.ts`, but the
   current WIP is not acceptable while the new CQ-117 overlay test fails because
   its `sessions.parquet` fixture lacks the `raw_record_id` column required by
   `session_facts`.
2. Fix CQ-116: DuckDB analytics must connect to real v2 compile output and
   handle sparse bundles.
3. Continue per-provider `search_doc` emission parity only as required support
   for the Tantivy gate, and do not present partial provider wiring as full
   Lane 3 completion.

Do **not** add more pure-read/audit/CLI surfaces unless they are directly required to implement or validate one of those runtime executors.

## Important correction

The prior claim that the Lane 3 runtime executors were blocked by `pnpm-workspace.yaml` `allowBuilds` was wrong. Direct smoke tests showed both native dependencies are runtime-available:

- `@duckdb/node-api` can create an in-memory DB and run `SELECT 42`.
- `@oxdev03/node-tantivy-binding` can build a schema.

The blocker is implementation work, not environment.

## Open blockers

Open blocking corrections:

- CQ-116: DuckDB analytics is not wired to real v2 compile output and fails
  sparse bundles.
- CQ-117: Compaction double-counts rows through the analytics overlay.

No `RALPH_DONE` is valid while any of these remain open.

## Supporting documents

- Source plan: `docs/rearch-2/`.
- Consolidated handoff: `docs/roadmap/rearch-2/cycle-reset-2026-05-19.md`.
- Current gates: `docs/roadmap/rearch-2/gates.md`.
- Current lane evidence: `docs/roadmap/rearch-2/evidence/`.
