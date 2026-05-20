# rearch-2 Correction Queue

Updated: 2026-05-20 after CQ-115 closed.

## Open blocking corrections

None currently recorded.

## Closed during this cycle

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
