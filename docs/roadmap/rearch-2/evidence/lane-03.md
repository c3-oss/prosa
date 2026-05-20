# Lane 3 Evidence — Derived layer

Updated: 2026-05-20 after Tantivy runtime writer landed.

## Status

Active / incomplete. Tantivy native runtime writer is in. DuckDB analytics runtime executor and Parquet compaction merge worker are still missing.

## Completed support foundation

- `packages/prosa-derived-v2` package scaffold and exports.
- SessionBlobPackV2:
  - writer/reader and byte-layout policy;
  - zstd codec;
  - path resolver and on-disk loader;
  - latest/current/historical transcript loaders;
  - listing, summary, exists, header, latest-epoch helpers;
  - read-side integration tests.
- Parquet/compaction support:
  - compaction policy and planner;
  - execution-plan composer;
  - projection segment listing/summary;
  - compact manifest build/read/write/deep validation;
  - superseded/compacted outputs helpers;
  - GC plan and GC execution-plan composers;
  - compaction effectiveness/history/overlap audit helpers.
- DuckDB analytics support:
  - fixed analytics view definitions;
  - pure execution-plan composer.
- Tantivy support:
  - schema/fingerprint;
  - rebuild planner/state machine;
  - checkpoint persistence;
  - index-dir probe/reset;
  - read-only status snapshot;
  - native runtime writer (`runTantivyRebuild`) — applies the plan
    against `@oxdev03/node-tantivy-binding`, handles full/incremental,
    persists the post-run checkpoint, and surfaces failures via a
    typed `RuntimeResult`. End-to-end gate covered by
    `packages/prosa-derived-v2/test/tantivy/runtime-writer.test.ts`.
  - `search_doc` projection-segment reader
    (`readSearchDocSegment`) — parses
    `<bundleRoot>/epochs/<epoch>/projection/search_doc.prosa-projection.ndjson`
    line-by-line, maps `SearchDocV2` to `SearchDocInputV2`, assigns
    synthetic 1-based rowids by position; returns `null` for missing
    segments and throws on malformed JSON / missing `doc_id`.
  - bundle-level orchestrator (`runTantivyRebuildForBundle`) — wires
    the reader into the runtime writer for a given `(bundleRoot, epoch)`
    pair. Reports `no_search_docs` when the segment is absent and
    forwards the inner `RuntimeResult` otherwise.
  - `prosa index-v2 tantivy` CLI subcommand — opens the bundle write
    lock, defaults `--epoch` to `head.epoch`, accepts
    `--overwrite / --heap-bytes / --num-threads`, prints the
    orchestrator's JSON result. Integration test runs the actual CLI
    subprocess against a synthetic v2 bundle + planted projection
    segment and confirms a follow-up `prosa index-v2 status` reports
    `tantivy.ready_for_read === true` with the matching
    `indexed_doc_count`.
- Operational/read surfaces:
  - `bundleDerivedStatus`, `derivedLayerMaintenanceSummary`, `recommendMaintenanceActions`, `derivedLayerFootprint`, `derivedLayerCapabilities`, `derivedLayerSnapshot`.
  - `prosa index-v2` read/audit subcommands in `apps/cli/src/cli/commands/index-v2.ts`.

## Required next implementation

- [x] Tantivy native writer / incremental rebuild runtime — landed
      with `runTantivyRebuild` + bundle orchestrator
      (`runTantivyRebuildForBundle`) + NDJSON projection reader +
      `prosa index-v2 tantivy` CLI command. CLI integration test
      runs the runtime through the spawned subprocess and asserts
      both the per-call result and the follow-up
      `index-v2 status.tantivy.ready_for_read`. Next step: a
      scripted compile-then-index gate (`compile-v2 <provider> &&
      index-v2 tantivy && index-v2 status`) against an
      importer-produced bundle, to cover the projection-segment
      shape end-to-end rather than the planted-fixture shape.
- [ ] DuckDB analytics runtime executor.
- [ ] Parquet compaction merge worker.
- [ ] End-to-end Lane 3 gates in `gates.md`.

## Deviation from original plan

The original Lane 3 plan required three runtime outputs: Tantivy writer, SessionBlob packs, DuckDB analytics over Parquet, plus compaction. The overnight loop implemented much more read/audit/CLI support than strictly required at this point, including several surfaces that conceptually belong to Lane 7 (CLI/MCP) or Lane 8 (audit/GC). Keep that work, but treat it as supporting infrastructure rather than completion evidence for the missing runtime executors.

## Current risk

The next loop may continue adding safe read-only utilities instead of tackling the runtime executor work. The next prompt explicitly forbids additional read/audit surfaces unless they directly support a selected runtime executor slice.

## CQ-115 closure (2026-05-20)

Codex review caught the cross-epoch skip foot-gun: the projection reader's
synthetic per-segment rowids made `runTantivyRebuildForBundle` route to `skip`
when a new epoch had fewer rows than the previously-indexed one. Fix:

- `IndexCheckpointV2` now carries `last_indexed_epoch` (legacy `null` collapses
  to the same "mismatch" branch).
- `planTantivyRebuild` takes an optional `currentEpoch` and returns
  `{ kind: 'full', reason: 'epoch_mismatch' }` when the caller's epoch differs
  from the checkpoint's recorded epoch (or the checkpoint has a prior `ready`
  run without a recorded epoch).
- `planTantivyRebuildFromBundle` + `runTantivyRebuild` + `runTantivyRebuildForBundle`
  thread the epoch through end-to-end; `checkpointAfterRebuild({ epoch })`
  persists it on success.

Regression evidence in
`packages/prosa-derived-v2/test/tantivy/rebuild-bundle.test.ts > CQ-115:
forces full / epoch_mismatch …` runs the exact Codex-smoke scenario (epoch 0 → 3
docs, epoch 1 → 2 docs) and asserts:

- second call: `plan = { kind: 'full', reason: 'epoch_mismatch' }`;
- checkpoint: `last_indexed_epoch = 1`, `indexed_doc_count = 2`,
  `source_doc_count = 2`;
- on-disk Tantivy index: `searcher.numDocs === 2`, an epoch-1-only `doc_id`
  query returns hits, an epoch-0-only `doc_id` returns 0 hits.

Four planner-level cases in `rebuild-plan.test.ts` cover the explicit mismatch,
the `null`-epoch + prior-ready case, the matching-epoch happy path, and the
legacy "no `currentEpoch` passed" path so callers that have not adopted epoch
tracking keep working.

Gate output (full closure command set):

- `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/tantivy/runtime-writer.test.ts test/tantivy/rebuild-bundle.test.ts test/tantivy/projection-reader.test.ts` → 17/17.
- `pnpm --filter @c3-oss/prosa exec vitest run test/cli/index-v2.test.ts -t tantivy` → 17/17 (137 in suite, 120 unrelated skipped).
- Full `pnpm --filter @c3-oss/prosa-derived-v2 test` → 563/563.

## Smoke + gate evidence (2026-05-20)

- `@oxdev03/node-tantivy-binding` v0.2.0 is loadable from the
  workspace; standalone smoke (`SchemaBuilder`/`Index`/`IndexWriter`)
  builds a one-doc index in `/tmp` successfully. This invalidates
  any prior claim that `allowBuilds` blocks Lane 3 runtime work.
- `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/tantivy/runtime-writer.test.ts`
  exercises full/skip/incremental/failure/tuning branches against
  the real native binding. All five tests pass; the full rebuild
  case asserts `checkpoint.indexed_doc_count == checkpoint.source_doc_count`
  and that `tantivyIndexDirIsValid(bundleRoot)` flips to `true`
  after the commit (`meta.json.segments.length > 0`).
- `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/tantivy/rebuild-bundle.test.ts test/tantivy/projection-reader.test.ts`
  drives the projection reader + bundle orchestrator end-to-end
  against a real NDJSON segment on disk. Five rebuild-bundle cases
  (no-segment / full / skip / incremental / forced overwrite) and
  five projection-reader cases (happy path / missing doc_id /
  malformed body / empty file / null on ENOENT) all pass; the full
  case asserts the Lane 3 gate (`status.ready_for_read === true` and
  `checkpoint.indexed_doc_count == checkpoint.source_doc_count`).
- Full `pnpm --filter @c3-oss/prosa-derived-v2 test` (556/556) +
  `typecheck` + `biome check .` + workspace `pnpm typecheck` all
  clean.
- `prosa index-v2 tantivy` CLI integration test (137/137 in
  `apps/cli/test/cli/index-v2.test.ts`, 17 tantivy-related)
  exercises the help text, missing-store error, no-search-docs
  fast path, full-rebuild end-to-end, `--overwrite` forced-full,
  and the `--heap-bytes 0` rejection branch. The full-rebuild case
  spawns a real `prosa index-v2 tantivy` subprocess, then spawns
  `prosa index-v2 status` and asserts `tantivy.ready_for_read ===
  true` with the matching `indexed_doc_count`.
