# rearch-2 Correction Queue

Updated: 2026-05-20 after CQ-119 closure.

## Open blocking corrections

None currently recorded.

## Closed during this cycle

### CQ-119: Lane 4 v2 promotion placeholders do not match the Lane 5 route contract

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

Lane 4 is supposed to define v2 promotion route placeholders that return 501
without implementing the Lane 5 protocol. The current placeholders do return
only placeholder responses, but two route definitions do not match the Lane 5
contract in `docs/rearch-2/06-lane-5-sync-protocol.md`:

- Expected `POST /v2/promotions/begin`, actual `POST /v2/promotions`.
- Expected `PUT /v2/promotions/:promotionId/segments/:segmentId`, actual
  `POST /v2/promotions/:promotionId/segments`.

Risk:

The Lane 4 gate can pass while pinning the wrong API surface. Lane 5 would then
either build client/server sync against the wrong paths or need to break the
Lane 4 placeholder contract immediately.

Smoke evidence:

```text
pnpm exec node --conditions=prosa-dev --import @swc-node/register/esm-register -e "import { V2_PROMOTION_ROUTES } from './src/v2/promotion.ts'; const expected = ['POST /v2/promotions/begin', 'PUT /v2/promotions/:promotionId/segments/:segmentId', 'POST /v2/promotions/:promotionId/object-packs', 'POST /v2/promotions/:promotionId/seal', 'GET /v2/receipts/:receiptId']; const actual = V2_PROMOTION_ROUTES.map((r) => r.method + ' ' + r.url); console.log(JSON.stringify({expected, actual, missing: expected.filter((x) => !actual.includes(x)), extra: actual.filter((x) => !expected.includes(x))}, null, 2)); process.exit(expected.every((x) => actual.includes(x)) ? 0 : 1);"
```

Run from `apps/api`; result exited `1` with:

```json
{
  "missing": [
    "POST /v2/promotions/begin",
    "PUT /v2/promotions/:promotionId/segments/:segmentId"
  ],
  "extra": [
    "POST /v2/promotions",
    "POST /v2/promotions/:promotionId/segments"
  ]
}
```

Required fix:

Update `apps/api/src/v2/promotion.ts` so `V2_PROMOTION_ROUTES` matches the Lane
5 endpoint contract exactly while still returning 501 for authorized callers.
Do not implement the promotion protocol.

Acceptance:

- [x] `V2_PROMOTION_ROUTES` exactly includes:
      `POST /v2/promotions/begin`,
      `PUT /v2/promotions/:promotionId/segments/:segmentId`,
      `POST /v2/promotions/:promotionId/object-packs`,
      `POST /v2/promotions/:promotionId/seal`, and
      `GET /v2/receipts/:receiptId`. Implemented in
      `apps/api/src/v2/promotion.ts`.
- [x] Tests assert the exact method/path contract, not only the operation names.
      `apps/api/test/v2/skeleton.test.ts > exactly matches the Lane 5 method/path contract`
      compares the sorted `${method} ${url}` list against the spec.
- [x] Tests prove each route returns `401` when unauthenticated and `501` when
      called by an authenticated tenant member. Two cases in
      `apps/api/test/v2/skeleton.test.ts` iterate the route list and assert
      both responses for every entry; signup runs through
      `/trpc/auth.signupWithTenant` so the same Better Auth + tenant
      resolution path the production server takes is exercised.
- [x] No Lane 5 promotion semantics are implemented. Each handler still returns
      `501 NOT_IMPLEMENTED` once auth and tenant pass.
- [x] Focused API v2 tests and `pnpm --filter @c3-oss/prosa-api lint` pass.
      `pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/skeleton.test.ts`
      → 5/5. `pnpm --filter @c3-oss/prosa-api lint` → clean.

### CQ-116: DuckDB analytics is not wired to real v2 compile output and fails sparse bundles

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

`runAnalyticsExecution` only reads Parquet globs
(`epochs/*/projection/<entity>.parquet` and compacted overlays), but
`compile-v2` currently writes canonical projection segments as
`*.prosa-projection.ndjson`. The focused DuckDB tests plant Parquet fixtures
directly, so they do not prove that a real `compile-v2` bundle can drive the
analytics runtime. Separately, the runtime skips temp-view setup for entities
with no Parquet files. That makes sparse real bundles fail when view SQL joins
optional tables such as `projects`, `turns`, `tool_calls`, `tool_results`,
`raw_records`, or `source_files`.

Risk:

The DuckDB runtime can pass planted-fixture tests while failing against actual
v2 bundle output or common sparse bundles. This blocks acceptance of `828b59f`
as a Lane 3 analytics runtime executor.

Smoke evidence:

- `compile-v2 codex` smoke on 2026-05-19 local time produced only:
  `*.prosa-projection.ndjson` files under `epochs/1/projection/`, plus epoch
  manifests. No `.parquet` projection files were emitted.
- Sparse-bundle smoke on 2026-05-19 local time planted only
  `epochs/0/projection/sessions.parquet` and ran
  `runAnalyticsExecution({ view: 'session_facts' })`. Result:
  `Catalog Error: Table with name projects does not exist`.

Required fix:

Connect analytics to real v2 projection output. Acceptable routes include
emitting Parquet projection segments during/after `compile-v2`, or adding a
documented, tested conversion/runtime binding from the canonical NDJSON
segments into DuckDB. Sparse bundles must materialise empty-but-typed temp
tables for missing optional entities, or otherwise prove every view degrades
correctly without `Table ... does not exist`.

Acceptance:

- [x] A fixture-backed `compile-v2` flow produces analytics-readable inputs.
      `apps/cli/test/cli/compile-to-analytics-gate.test.ts` spawns the real
      `prosa compile-v2 codex` subprocess against a synthetic codex JSONL
      (session_meta + user message + assistant message), then drives
      `runAnalyticsExecution({view:'session_facts'})` in-process against the
      resulting bundle. Asserts the report row reports `source_session_id` =
      `sess_cq116_codex`, `message_count` = 2, `user_message_count` = 1,
      `assistant_message_count` = 1, and `skippedEntities` is `[]`.
- [x] `runAnalyticsExecution` succeeds on a sparse real or realistic bundle
      with no projects/tool calls/tool results/events. The runtime now
      materialises every analytics entity that has no on-disk file as a
      typed-but-empty stub
      (`(SELECT NULL AS field1, ..., NULL AS fieldN WHERE FALSE)`)
      with the column list derived from `ENTITY_SCHEMA_ORDER`. Stub columns
      use bare `NULL` so DuckDB infers the type from the surrounding
      expression context, which avoids `Cannot mix values of type VARCHAR and
      INTEGER_LITERAL in COALESCE`-style errors in view bodies.
- [x] Focused tests cover the sparse-table case and the real compile-output
      path, not only planted Parquet fixtures.
      `packages/prosa-derived-v2/test/analytics/cq116-sparse-and-ndjson.test.ts`
      covers the sparse-bundle Parquet path (one entity has Parquet; the
      others get typed empty stubs) and the NDJSON-only path
      (`<entity>.prosa-projection.ndjson` segments are read via DuckDB's
      `read_json_auto` with `format='newline_delimited'`, filtering the
      canonical header line via `WHERE entityType IS NULL`). The CLI-level
      `compile-to-analytics-gate.test.ts` covers the full real-compile-v2
      path end-to-end.
- [x] Evidence is recorded in `docs/roadmap/rearch-2/evidence/lane-03.md`.

### CQ-117: Compaction double-counts rows through the analytics overlay

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

`runCompaction` writes compacted Parquet outputs but intentionally leaves all
source live segments in place. The analytics binding reads both live globs and
compacted globs unconditionally. Without a compact manifest / superseded filter
in the query path, post-compaction consumers see both the original rows and the
compacted rows.

Risk:

The compaction worker can report that it wrote a row-preserving compacted file
while the logical row set visible to analytics is doubled. That violates the
Lane 3 gates requiring compaction to preserve logical rows and reduce effective
file count below the threshold.

Smoke evidence:

On 2026-05-19 local time, a direct smoke planted 33 one-row
`sessions.parquet` live segments, ran `runCompaction({ bundleRoot })`, then
queried the analytics `parquetReadFor(bundleRoot, 'sessions')` overlay.
Result:

```json
{"beforeCount":33,"afterCount":66,"compactedRows":33,"resultCount":1}
```

Required fix:

Define and implement the post-compaction visibility contract. The runtime must
either write/read a compact manifest that excludes superseded live segments from
consumers, move/delete superseded files as part of an explicit safe phase, or
otherwise make analytics/readers see exactly one logical copy of each row after
compaction.

Acceptance:

- [x] Post-compaction analytics/read queries preserve logical row counts.
      `runCompaction` now persists a `compact.manifest.json` for every
      non-empty plan via `buildCompactManifestV2` + `writeCompactManifestV2`
      and exposes the resolved manifest path on the result. The analytics
      runtime (`runAnalyticsExecution`) aggregates
      `listSupersededSegmentsFromManifests` + `listProjectionSegments` +
      `listCompactedOutputs` and rewrites the composer's `read_parquet([...])`
      array to an explicit per-entity file list: live segments minus
      superseded paths, plus existing compacted outputs.
- [x] The effective file set for compacted entities drops below the policy
      threshold (the analytics overlay reads one compacted file instead of
      33 live segments for `sessions`).
- [x] A focused integration test plants many live Parquet segments, runs
      compaction, then proves the consumer-visible row count remains
      unchanged.
      `packages/prosa-derived-v2/test/compaction/compaction-analytics-overlay.test.ts`
      plants 33 distinct `sessions.parquet` segments + minimum-viable stubs
      for every other canonical entity the `session_facts` view body joins
      against; pre-compaction the overlay sees 33 sessions; post-compaction
      the overlay still sees 33 (not 66) AND
      `listSupersededSegmentsFromManifests` returns 33 entries.
- [x] Governor re-ran focused gates on 2026-05-19 local time:
      `test/compaction/compaction-analytics-overlay.test.ts` → 2/2,
      `test/compaction/runtime-worker.test.ts` → 10/10,
      `test/analytics/runtime-executor.test.ts` → 7/7.
- [x] Evidence is recorded in `docs/roadmap/rearch-2/evidence/lane-03.md`.

### CQ-118: Compaction caller-supplied plans can escape bundleRoot

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

`runCompaction` accepts caller-supplied plans for tests/scripted gates and feeds
them to `planCompactionExecution` without validating that
`segmentsToMerge[].path` and `outputPath` remain inside `bundleRoot`.

Risk:

An injected plan can make the worker read from or write to paths outside the
bundle root. Even dry-run exposes the escaping execution plan; non-dry-run would
`mkdir` and execute DuckDB `COPY` against the resolved output path.

Smoke evidence:

On 2026-05-19 local time, a dry-run injected plan with
`segmentsToMerge[0].path = '../outside-input.parquet'` and
`outputPath = '../outside-output.parquet'` returned:

```json
{
  "outputAbsPath": "/tmp/outside-output.parquet",
  "outputRelativeToBundle": "../outside-output.parquet",
  "sqlContainsOutsideInput": true
}
```

Required fix:

Validate caller-supplied compaction plans before composing or executing SQL.
Reject absolute paths, `..` traversal, symlink escape, and any resolved input or
output path outside `bundleRoot`. Keep planner-generated plans working.

Acceptance:

- [x] Injected plan paths are containment-checked before execution planning or
      before any DuckDB/file side effect. `runCompaction` calls a new
      `assertPlanContained(plan, bundleRoot)` helper immediately after resolving
      the plan and before `planCompactionExecution`. The helper rejects empty
      paths, absolute paths, any `..` component (regardless of where it
      resolves), and any resolved path that escapes the bundle root via
      `path.relative()`.
- [x] Regression tests cover escaping segment paths and escaping output paths.
      Five new cases in
      `packages/prosa-derived-v2/test/compaction/runtime-worker.test.ts`:
      absolute `segmentsToMerge[].path`, `..` in `segmentsToMerge[].path`,
      absolute `outputPath`, `..` in `outputPath`, and a dry-run path that
      proves containment runs before any FS / DuckDB side effect.
- [x] Focused compaction tests still pass (original 5 + 5 new = 10/10).
      Governor re-ran
      `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/compaction/runtime-worker.test.ts`
      on 2026-05-19 local time: 10/10.
- [x] Direct post-fix smoke rejects the original escape before exposing an
      execution plan:
      `assertPlanContained: segmentsToMerge[].path for entity sessions
      "../outside-input.parquet" contains '..' traversal`.
- [x] Evidence is recorded in `docs/roadmap/rearch-2/evidence/lane-03.md`.

### CQ-115: Tantivy bundle rebuild skips incorrectly across epoch changes

Severity: high
Blocking: yes
Status: closed (2026-05-20)
Owner: Ralph

Problem:

`runTantivyRebuildForBundle` reads a single epoch's
`search_doc.prosa-projection.ndjson` and assigns synthetic 1-based rowids by
position. The code comments correctly say those rowids reset across epochs, but
the persisted checkpoint does not include the indexed epoch or segment identity.
When epoch 0 has three rows and epoch 1 has two rows, the second run sees
`currentMaxRowid = 2 <= last_indexed_rowid = 3` and incorrectly returns `skip`.
The checkpoint remains `indexed_doc_count = 3` and `source_doc_count = 3` even
though the selected source segment has two rows.

Risk:

`prosa index-v2 tantivy` can report `ready_for_read` for a stale index after
head advances to an epoch whose synthetic rowid range is shorter than the prior
indexed epoch. This can hide missing or stale search documents while satisfying
the current checkpoint-only gate.

Required fix:

Make the Tantivy rebuild planner/orchestrator epoch-aware, or otherwise bind the
checkpoint to a stable source segment identity. A run for a different epoch or
different source segment must not use the prior epoch's synthetic rowid
watermark to skip. Safe defaults:

- force a full rebuild when the requested epoch differs from the checkpointed
  epoch/source identity; or
- persist and compare an explicit source segment digest/identity before allowing
  `skip` or `incremental`.

Acceptance:

- [x] Code prevents cross-epoch `skip` based only on synthetic rowid position.
      `IndexCheckpointV2` now carries `last_indexed_epoch`; `planTantivyRebuild`
      gates on `input.currentEpoch` and returns `full / epoch_mismatch` when the
      checkpoint's epoch differs (or is `null` while a prior `ready` run exists);
      `planTantivyRebuildFromBundle` + `runTantivyRebuild` +
      `runTantivyRebuildForBundle` thread the epoch through and persist it via
      `checkpointAfterRebuild({ epoch })`.
- [x] Regression test covers epoch 0 with 3 docs followed by epoch 1 with 2 docs
      and proves the second run rebuilds. See
      `packages/prosa-derived-v2/test/tantivy/rebuild-bundle.test.ts > CQ-115:
      forces full / epoch_mismatch when the bundle moves to a new epoch …`.
- [x] The regression asserts both checkpoint parity (`indexed_doc_count = 2`,
      `source_doc_count = 2`, `last_indexed_epoch = 1`) AND actual Tantivy index
      content: opens the on-disk index, asserts `searcher.numDocs === 2`,
      confirms an epoch-1-only `doc_id` matches the query and an epoch-0-only
      `doc_id` does not. Four additional planner-level cases in
      `rebuild-plan.test.ts` cover the explicit `currentEpoch` mismatch, the
      `null`-epoch checkpoint with a prior `ready` run, the matching-epoch happy
      path (`skip` / `incremental`), and the legacy "no `currentEpoch`" path.
- [x] Focused gates pass:
      `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run test/tantivy/runtime-writer.test.ts test/tantivy/rebuild-bundle.test.ts test/tantivy/projection-reader.test.ts`
      → 17/17 on 2026-05-20.
      `pnpm --filter @c3-oss/prosa exec vitest run test/cli/index-v2.test.ts -t tantivy`
      → 17/17 (137 in the suite, 120 unrelated skipped) on 2026-05-20.
- [x] Evidence is recorded in `docs/roadmap/rearch-2/evidence/lane-03.md`.

Evidence:

- Pre-fix Codex smoke on 2026-05-19:
  `node --conditions=prosa-dev --import @swc-node/register/esm-register --input-type=module`
  from `packages/prosa-derived-v2`, indexing epoch 0 with `doc-a/doc-b/doc-c`
  and epoch 1 with `doc-x/doc-y`, returned:
  `secondResult: "skipped"`, `secondPlan.kind: "skip"`,
  `secondPlan.currentMaxRowid: 2`, while status still reported
  `last_indexed_rowid: 3`, `indexed_doc_count: 3`,
  `source_doc_count: 3`, and `ready_for_read: true`.
- Post-fix regression (2026-05-20): the same scenario via
  `runTantivyRebuildForBundle` now returns
  `result.plan = { kind: 'full', reason: 'epoch_mismatch' }` for the epoch-1
  call, with `checkpoint.last_indexed_epoch = 1`, `indexed_doc_count = 2`,
  `source_doc_count = 2`. The on-disk Tantivy index reports
  `searcher.numDocs === 2`, an epoch-1 doc_id query returns ≥1 hit, and the
  epoch-0 doc_id query returns 0 hits.

## Historical closeout summary

- CQ-001..CQ-019: Lane 0 foundation/canonical/wire/CI integrity corrections closed.
- CQ-020..CQ-066: Lane 1 local-store integrity, durability, containment, rebuild and evidence corrections closed.
- CQ-067..CQ-082: Lane 2 importer/provider/CLI/idempotency corrections closed; Lane 2 accepted by Codex/governor on 2026-05-19.
- CQ-083..CQ-114: Lane 3 derived-layer scaffolding, SessionBlob, Tantivy planning/status, compaction/audit, CLI/read-surface, maintenance and corruption-gate corrections closed.
- CQ-115: Tantivy bundle rebuild now refuses to compare rowids across epochs; closed 2026-05-20 (full closure record above).

## Carry-forward lessons

- A correction blocks `RALPH_DONE` and dependent acceptance, but should not force an empty executor loop if unrelated implementation can continue safely.
- Every blocker claim must include a direct verification command or observable evidence.
- Do not close corrections based only on agent claims; require code, tests and evidence.

## New correction template

```text
### CQ-115: <short title>

Severity: critical | high | medium | low
Blocking: yes | no
Status: open
Owner: Ralph | Codex | reviewer

Problem:

Risk:

Required fix:

Acceptance:
- [ ] Code change is present.
- [ ] Focused tests/gates pass.
- [ ] Evidence is recorded in the relevant lane file.
```
