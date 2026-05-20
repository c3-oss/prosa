# Lane 3 Evidence — Derived layer

Updated: 2026-05-20 after governor review opened CQ-116..CQ-118.

## Status

Active / incomplete. The Tantivy compile-to-index gate is satisfied for the
Codex fixture path (compile-v2 → index-v2 tantivy → index-v2 status), but Lane 3
is not complete. DuckDB analytics runtime code landed in `828b59f` and Parquet
compaction runtime code landed in `2345798`; both are kept as core Lane 3 work
but are not governor-accepted while CQ-116..CQ-118 remain open.

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
  - compaction effectiveness/history/overlap audit helpers;
  - runtime merge worker (`runCompaction`) — opens DuckDB, mkdir's
    each entity's output dir, runs the composer's COPY statements,
    reads back the on-disk output byte length + row count, returns
    per-entity stats. Non-destructive: the worker never touches the
    live `epochs/<n>/projection/` segments. Supports a `dryRun`
    mode that returns the planned work without opening DuckDB.
    **Not accepted yet:** CQ-117 and CQ-118 block compaction acceptance.
- DuckDB analytics support:
  - fixed analytics view definitions;
  - pure execution-plan composer;
  - runtime executor (`runAnalyticsExecution`) — opens an in-process
    `@duckdb/node-api` connection, probes each canonical entity's
    parquet globs (filters out empty-match globs to avoid DuckDB's
    `IO Error: No files found`), runs setup statements + report
    query, returns `{ view, columns, rows, executedSetupStatements,
    skippedEntities }`. Drops entity setup statements entirely when
    both live + compacted globs are empty so the caller sees an
    authentic "missing parquet" failure instead of a glob error.
    **Not accepted yet:** CQ-116 blocks analytics acceptance.
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
- [x] Tantivy compile-to-index gate — landed
      (`apps/cli/test/cli/compile-to-index-gate.test.ts`). The test
      spawns `prosa compile-v2 codex` against a synthetic Codex
      rollout fixture (`session_meta` + two `response_item` messages
      with `input_text` / `output_text` content), reads back the
      importer-produced
      `epochs/<n>/projection/search_doc.prosa-projection.ndjson` to
      confirm ≥ 1 search_doc row landed, spawns
      `prosa index-v2 tantivy` against the resulting v2 bundle, then
      spawns `prosa index-v2 status` and asserts
      `tantivy.ready_for_read === true`,
      `checkpoint.last_indexed_epoch === sealedEpoch`, and
      `checkpoint.indexed_doc_count === checkpoint.source_doc_count`.
      The v2 codex importer gained a minimal `buildSearchDocs`
      step that emits one `SearchDocV2` per message with indexable
      text (`input_text` / `output_text` / `text` blocks); full v1
      parity for tool-call / tool-result / per-block fan-out remains
      a follow-up.
- [ ] DuckDB analytics runtime executor — code landed in `828b59f` with
      `runAnalyticsExecution` + a focused 7-test suite that materialises
      each of the 5 fixed views against minimal Parquet fixtures
      (planted via DuckDB's own `COPY ... TO ... (FORMAT PARQUET)`),
      verifies column-shape parity with `ANALYTICS_VIEW_COLUMNS`, and
      asserts row counts + `skippedEntities` reporting. Governor acceptance is
      blocked by CQ-116: real `compile-v2` output is currently NDJSON, not
      Parquet, and sparse bundles can fail with missing temp tables.
- [ ] Parquet compaction merge worker — code landed in `2345798` but is not
      accepted while CQ-117/CQ-118 remain open
      (`packages/prosa-derived-v2/src/compaction/runtime-worker.ts`).
      Five focused tests under
      `packages/prosa-derived-v2/test/compaction/runtime-worker.test.ts`
      cover: under-threshold no-op (empty plan), 33-small-segment
      `file_count_trigger` scenario (compacted file written + 33 rows
      preserved end-to-end), dry-run path (no DuckDB connection / no
      file written), caller-supplied trimmed plan (worker honours
      `segmentsToMerge.slice(...)` exactly), and on-disk byte-length
      reporting parity. Source live segments confirmed unchanged
      after the worker runs (non-destructive contract). Reviewer/direct smoke
      evidence shows that this non-destructive contract currently makes the
      analytics overlay double-count rows after compaction unless a manifest or
      superseded filter is applied.
- [ ] End-to-end Lane 3 gates in `gates.md`.

## Deviation from original plan

The original Lane 3 plan required three runtime outputs: Tantivy writer, SessionBlob packs, DuckDB analytics over Parquet, plus compaction. The overnight loop implemented much more read/audit/CLI support than strictly required at this point, including several surfaces that conceptually belong to Lane 7 (CLI/MCP) or Lane 8 (audit/GC). Keep that work, but treat it as supporting infrastructure rather than completion evidence for the missing runtime executors.

## Current risk

The next loop may continue adding safe read-only utilities instead of tackling the runtime executor work. The next prompt explicitly forbids additional read/audit surfaces unless they directly support a selected runtime executor slice.

## Governor review blockers (2026-05-20)

Reviewer subagents plus direct smokes found that DuckDB analytics and Parquet
compaction code are useful core Lane 3 work, but not acceptance-ready.

- CQ-116: `compile-v2 codex` produced only
  `*.prosa-projection.ndjson` projection files under `epochs/1/projection/`
  (`content_block`, `message`, `raw_record`, `search_doc`, `session`,
  `source_file`) plus epoch manifests. No `.parquet` files were emitted, while
  `runAnalyticsExecution` reads only Parquet globs. A sparse-bundle smoke with
  only `sessions.parquet` failed with
  `Catalog Error: Table with name projects does not exist`, confirming that
  missing optional entity temp tables currently break `session_facts`.
- CQ-117: a direct compaction smoke planted 33 one-row live
  `sessions.parquet` segments, ran `runCompaction({ bundleRoot })`, then queried
  the analytics overlay via `parquetReadFor(bundleRoot, 'sessions')`. Result:
  `beforeCount = 33`, `afterCount = 66`, `compactedRows = 33`. The compacted
  file is row-preserving in isolation, but consumers see live + compacted rows.
- CQ-118: a dry-run injected plan with `../outside-input.parquet` and
  `../outside-output.parquet` resolved `outputAbsPath` to
  `/tmp/outside-output.parquet` and generated SQL containing the outside input
  path. Caller-supplied compaction plans need containment validation before
  execution planning or side effects.

Focused tests that still pass and should remain green while fixing the CQs:

- `pnpm --filter @c3-oss/prosa exec vitest run test/cli/compile-to-index-gate.test.ts`
  → 1/1.
- `pnpm --filter @c3-oss/prosa exec vitest run test/cli/index-v2.test.ts -t tantivy`
  → 17/17 selected, 120 skipped.
- `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/analytics/runtime-executor.test.ts`
  → 7/7.
- `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/compaction/runtime-worker.test.ts`
  → 5/5.
- `pnpm --filter @c3-oss/prosa-importers-v2 test -- --runInBand`
  → 40/40.

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

## DuckDB analytics runtime (2026-05-20)

- `@duckdb/node-api` 1.5.2-r.1 is loadable from `prosa-derived-v2`;
  smoke (`CREATE TEMP VIEW`/`SELECT count(*)`) ran inline before the
  dep landed. `read_parquet([live, compact])` rejects empty globs
  with `IO Error: No files found that match the pattern`; the
  runtime executor probes via `node:fs/promises.glob` and filters
  out empty matches before issuing the setup statement, so a fresh
  bundle with only live segments runs cleanly without a compacted
  overlay.
- `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run
  test/analytics/runtime-executor.test.ts` → 7/7. Cases cover all
  five fixed views (`session_facts`, `tool_usage_facts`,
  `error_facts`, `model_usage`, `project_activity`) with
  `result.columns === ANALYTICS_VIEW_COLUMNS[view]`, row counts that
  match seeded fixtures, and the `skippedEntities` reporter when an
  entity has no Parquet. A caller-supplied `reportQuery` case
  confirms custom queries flow through to DuckDB verbatim.
- Full `pnpm --filter @c3-oss/prosa-derived-v2 test` → 570/570
  (54 files); typecheck + biome clean; workspace `pnpm typecheck`
  green (13/13 packages).

## Compile-to-index gate (2026-05-20)

- `apps/cli/test/cli/compile-to-index-gate.test.ts` runs the full
  governance gate: spawns `prosa compile-v2 codex` against a
  synthetic codex JSONL containing one `session_meta` + two
  `response_item` messages (user + assistant) with indexable
  `input_text` / `output_text` content; reads back
  `epochs/<n>/projection/search_doc.prosa-projection.ndjson` to
  confirm ≥1 search_doc row was emitted; spawns
  `prosa index-v2 tantivy --store … --heap-bytes 15000000 --num-threads 1`;
  spawns `prosa index-v2 status` and asserts
  `tantivy.ready_for_read === true`,
  `checkpoint.last_indexed_epoch === sealedEpoch`, and
  `checkpoint.indexed_doc_count === checkpoint.source_doc_count`.
- The v2 codex importer now emits one `SearchDocV2` per message
  with indexable text (`input_text` / `output_text` / `text`
  blocks); full v1 parity for tool-call / tool-result / per-block
  fan-out is a follow-up. Without this importer change the gate
  would fail with `no_search_docs` because the projection segment
  would be empty.
- Gate output: `pnpm --filter @c3-oss/prosa exec vitest run
  test/cli/compile-to-index-gate.test.ts` → 1/1 (~5.5s). Full
  importers suite → 40/40, derived-v2 suite → 570/570, CLI tantivy
  CLI subset → 17/17, workspace `pnpm typecheck` clean.

## Compaction merge worker (2026-05-20)

- `packages/prosa-derived-v2/src/compaction/runtime-worker.ts`
  closes the loop on Lane 3 compaction: `runCompaction({bundleRoot,
  plan?, dryRun?})` resolves the plan (caller-supplied or via
  `planCompaction(bundleRoot)`), composes it through
  `planCompactionExecution`, opens a DuckDB connection, mkdir's
  each entity's output dir, executes the `COPY (SELECT * FROM
  read_parquet([...], union_by_name => true)) TO ... (FORMAT
  'parquet', CODEC 'zstd');` statement, reads the resulting file's
  byte length + row count, and returns `{plan, executionPlan,
  results, empty, dryRun}`. Source live segments are never
  touched — superseded cleanup is a separate planner/runtime
  concern. The merge is row-preserving by construction.
- Focused 5-test suite at
  `packages/prosa-derived-v2/test/compaction/runtime-worker.test.ts`
  covers: under-threshold no-op (empty plan), 33-small-segment
  `file_count_trigger` end-to-end (compacted file at
  `epochs/compact-0001/projection/sessions.compacted.parquet`
  contains 33 distinct rows; source live segments still exist),
  dry-run (no DuckDB connection, no file written), caller-supplied
  trimmed plan (worker honours `segmentsToMerge.slice(0, 17)`
  verbatim), and `outputByteLength === stat(outputAbsPath).size`
  parity.
- Gate output: `pnpm --filter @c3-oss/prosa-derived-v2 exec
  vitest run test/compaction/runtime-worker.test.ts` → 5/5 (~1.7s).
  Full @c3-oss/prosa-derived-v2 suite → 575/575 (55 files);
  typecheck + biome clean; workspace `pnpm typecheck` → 13/13.

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

## CQ-118 closure + per-provider search_doc parity (2026-05-20)

- Extracted shared `buildSearchDocsFromMessageBlocks(draft)` helper in
  `packages/prosa-importers-v2/src/search-doc-builder.ts`. Wired
  into codex / claude / cursor / gemini / hermes importers. Each
  message with `input_text` / `output_text` / `text` blocks now
  produces one `SearchDocV2` row with the same shape across
  providers; full v1 tool-call / tool-result fan-out remains a
  follow-up.
- Extended `apps/cli/test/cli/compile-to-index-gate.test.ts` with a
  second case driving `compile-all-v2` against codex / claude /
  gemini / hermes fixtures (cursor's bundle is opaque). Asserts
  every won provider produces ≥1 search_doc and the merged Tantivy
  index reports `ready_for_read === true` with matching counts.
- CQ-118 fix landed: `runCompaction` calls a new
  `assertPlanContained(plan, bundleRoot)` helper immediately after
  resolving the plan and before composing or running anything.
  Rejects absolute paths, `..` traversal components, and resolved
  escapes via `path.relative()`. Five new regression cases in
  `packages/prosa-derived-v2/test/compaction/runtime-worker.test.ts`
  (absolute / `..` in segmentsToMerge[].path; absolute / `..` in
  outputPath; dry-run path containment before any side effect).
- Gate output: `pnpm --filter @c3-oss/prosa-derived-v2 exec
  vitest run test/compaction/runtime-worker.test.ts` → 10/10.
  Full `pnpm --filter @c3-oss/prosa-derived-v2 test` → 580/580
  (55 files). Full `pnpm --filter @c3-oss/prosa-importers-v2
  test` → 40/40. `pnpm --filter @c3-oss/prosa exec vitest run
  test/cli/compile-to-index-gate.test.ts` → 2/2. typecheck +
  biome clean across all touched packages.
