# Ralph Loop Cycle Reset — rearch-2

Generated: 2026-05-19 after the overnight wrap-up.  
Repository: `/home/cain/workspace/code/c3-oss/prosa`  
Branch: `feature/rearch`

This document consolidates the noisy Ralph/Codex/Hermes control trail into a clean next-turn handoff. It supersedes the root wrap-up scratch files and the long-form historical control logs for the purpose of resuming work.

## Current git snapshot

```text
HEAD 8e8a662 docs(infra): correct native-binding allowlist misclassification on Lane 3 runtime executors
STATUS
## feature/rearch...origin/feature/rearch [ahead 1]
?? CODEX_NIGHT_WRAPUP.md
?? NIGHT_TRIAD_ANALYSIS.md
?? RALPH_NIGHT_WRAPUP.md
?? packages/prosa-derived-runtime-v2/
COUNTS 1
```

## Source-of-truth plan vs current state

The source plan remains `docs/rearch-2/`. The active implementation state is:

- **Lane 0 — Foundation:** accepted. Canonical entities, hashing, wire schemas, conformance and CI are in place.
- **Lane 1 — Local store:** accepted, including the user-approved rescopes recorded in `docs/rearch-2/lane-1-rescopes.md`.
- **Lane 2 — Importers:** accepted by Codex/governor on 2026-05-19. Provider implementations and compile orchestration are in place.
- **Lane 3 — Derived layer:** active/incomplete. A large pure-read/audit/CLI foundation exists, but the lane is not done because the runtime executors are still missing.
- **Lane 4 — Server:** only early `packages/prosa-db-v2` scaffold/test work exists. The lane should not be treated as started for delivery purposes.
- **Lanes 5–10:** not started; remain blocked by earlier lanes per `docs/rearch-2/`.

## Lane 3: completed foundation

Completed and accepted as useful support work:

- `packages/prosa-derived-v2` scaffold and exports.
- SessionBlobPackV2 byte layout, writer/reader, zstd codec, on-disk loading, latest/current/historical reads, transcript loading, header/exists/latest/summary/listing helpers.
- Parquet compaction policy/planner, execution-plan composer, segment listing/summary, compact manifest persistence, superseded/compacted-output helpers, GC plan/execution-plan composers.
- DuckDB analytics view definitions and pure execution-plan composer.
- Tantivy schema, rebuild planner, index-dir probe/reset, checkpoint persistence, status snapshot.
- Derived layout/capabilities/maintenance/snapshot/footprint/overlap audit read surfaces.
- Many focused tests and CLI smoke/coherence tests around the read/audit surface.

## Lane 3: still required before calling the lane done

These are the next real milestones. They should be attacked directly before adding more audit-only surfaces:

1. **Tantivy native writer / incremental rebuild runtime**
   - Actually build/update the Tantivy index from bundle v2 data.
   - Persist generation/checkpoint status and prove `indexed_doc_count == source_doc_count`.

2. **DuckDB analytics runtime executor**
   - Actually open DuckDB and execute the view/query plans against v2 Parquet.
   - Prove fixed reports match expected v1/v2 row counts where comparable.

3. **Parquet compaction merge worker**
   - Actually merge small epoch segments into compacted Parquet outputs.
   - Write/read compact manifests and prove logical row-set preservation.

4. **Lane-3 gate wiring**
   - `prosa compile-all-v2 && prosa index-v2 status` shows ready Tantivy.
   - v2 transcript rendering matches v1 for same input.
   - analytics core reports match expected counts.
   - scripted 100-small-epoch compaction scenario reduces file count below threshold.

## Work implemented earlier than the plan strictly needed

The following is useful but was largely ahead-of-plan relative to `docs/rearch-2/`:

- `prosa index-v2` operational/audit subcommands created before Lane 7's official `prosa read *` CLI/MCP lane.
- Maintenance dashboard, `next-action`, footprint, capabilities, snapshot and overlap/corruption-gate surfaces, which overlap conceptually with Lane 8 audit/GC concerns.
- Numerous pure-read helpers for inventory, manifests, summaries and diagnostics that are helpful for operators/agents but do not themselves complete the Lane 3 runtime executor requirement.

Current `prosa index-v2` subcommands:

- `maintenance`
- `next-action`
- `status`
- `sessions`
- `epochs`
- `analytics-views`
- `projection-segments`
- `analytics-execution-plan`
- `tantivy-schema`
- `tantivy-rebuild-plan`
- `compaction-plan`
- `compaction-manifest`
- `compaction-execution-plan`
- `gc-plan`
- `derived-layout`
- `snapshot`
- `capabilities`
- `footprint`
- `compaction-overlaps`
- `compaction-history`
- `compaction-effectiveness`
- `gc-execution-plan`
- `compacted-outputs`
- `superseded-segments`
- `verify-packs`
- `transcript-header`
- `transcript`

This early work should be treated as **supporting infrastructure**, not as replacement for the missing runtime executors.

## Overnight triad assessment

The executor/evaluator/intervener triad worked, but needs tighter steering:

- **What worked:** Ralph produced many small tested increments; Codex caught real defects through CQs; Hermes unblocked TUI/process issues and stopped the monitor when asked.
- **What failed:** the loop became too comfortable producing pure-read/audit increments; Codex nudged too frequently for part of the night; and the native-binding `allowBuilds` blocker was accepted for too long without a direct smoke test.
- **Key correction:** `@duckdb/node-api` and `@oxdev03/node-tantivy-binding` are runtime-available in this workspace. The remaining Lane 3 blocker is implementation, not environment.

## Next-cycle operating rules

- Start with one runtime executor slice, not another audit/read surface.
- If a claimed blocker appears, verify it with a direct smoke command before rerouting work.
- Codex/governor should use patient monitoring by default: no five-minute nudging while Ralph is working/thinking/productive.
- Batch evidence/status pins unless closing a blocking CQ.
- Keep acceptance gates blocking `RALPH_DONE`, not unrelated productive implementation.

## Historical scratch files consolidated here

The content of the root scratch files was reviewed and summarized into this handoff:

- `CODEX_NIGHT_WRAPUP.md`
- `RALPH_NIGHT_WRAPUP.md`
- `NIGHT_TRIAD_ANALYSIS.md`

They can be deleted from the repository root after this file is committed or otherwise preserved.
