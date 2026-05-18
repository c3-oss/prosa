# Lane Evidence

Lane: 02 - Importers
Status: out-of-sequence WIP (unaccepted; tracked by CQ-044). The
`LogicalImportUnit` contract, `GraphResolver`, and `runCompileImports`
orchestrator landed at `004107c` while Lane 1 still had open
blocking integrity corrections. The package now passes its focused
gates (8 tests) at `5e4b5e7` but is **not** counted as accepted lane
progress. Each per-provider importer — Codex, Claude Code, Cursor,
Gemini, Hermes — remains its own follow-up iteration. No new Lane 2
feature work is allowed until Codex re-review accepts Lane 1.
Owner: Ralph
Commit range: `004107c` (out-of-sequence) + later CQ-047 backfill in `5e5ca20`

## Acceptance Criteria

- [x] `packages/prosa-importers-v2` scaffolded and wired into the
  monorepo with paths to `@c3-oss/prosa-types-v2` and
  `@c3-oss/prosa-bundle-v2`.
- [x] `LogicalImportUnit`, `CanonicalProjectionDraft`, and the
  `Provider` interface (`discover` → `cheapIdentify` → `parseAndProject`)
  defined and exported.
- [x] `reserveSession()` helper wraps the shard actor `Reserve` op and
  reports `won` / `lost` / `serialization_error`.
- [x] `resolveLateBindings()` + `LateBindingIndex` implemented with the
  current-epoch policy: `inline` when `parent_session_id` is populated,
  `edge_derived` when the spawned-edge parent lives in the same epoch,
  `fixup_derived` (with a `SessionFixupV2`) when a `PriorEpochSessionInventory`
  resolves the parent, otherwise `unresolved`.
- [x] `runCompileImports(bundle, providers, ...)` orchestrator:
  - `beginEpoch` → per-provider sequential loop;
  - per-file `Reserve` (or always-won when no shard is supplied);
  - `parseAndProject` on winners; raw bytes streamed through
    `RawSourcePackWriterPool`;
  - per-entity `writeProjectionSegment` emit + `registerSegment`;
  - `resolveLateBindings` + `sealEpoch`.
- [x] Unit tests: 5 for `resolveLateBindings`, 3 for the orchestrator
  end-to-end with a mock provider (`@c3-oss/prosa-importers-v2`: 8
  tests / 2 files).
- [ ] **Per-provider importers (codex, claude, cursor, gemini, hermes)
  not yet implemented.** Each provider has its own discovery + parse
  surface (Codex JSONL, Claude JSONL, Cursor SQLite, Gemini protobuf,
  Hermes SQLite+JSONL merge); none of that logic is shared, and each
  is its own substantial port from v1. Tracked as follow-up iterations.
- [ ] `apps/cli/test/compile-v2.test.ts` (cross-provider parity with v1)
  pending the per-provider importer landings.
- [ ] Invariants I2 (idempotency) and I3 (canonical graph) not yet
  validated against real fixture corpora — pending per-provider work.

## Implementation Notes

- Source contract: `docs/rearch-2/03-lane-2-importers.md`.
- The orchestrator deliberately keeps the per-provider parse synchronous
  + sequential. The lane doc reserves a `--experimental-parallel` flag
  for later.
- `mockProvider` in `test/unit/orchestrator.test.ts` is the reference
  shape for a real provider: discover → cheapIdentify → parseAndProject
  returning a `LogicalImportUnit` with `raw_source_payloads` and a
  fully populated `CanonicalProjectionDraft`.
- The orchestrator picks the projection segment-writer (`projection_arrow`
  kind in `DurableSegmentRef`) for every non-empty entity in the
  `PROJECTION_ENTITY_ORDER`. `sealEpoch`'s durability check (Lane 1
  CQ-031) then verifies the segment bytes against the in-memory rows.
- `parent_resolution` is set in one pass over all rows after every
  provider has run; cross-epoch fixups are emitted but not yet
  written into a `session_fixup_v2` projection segment — that is
  intentional because Lane 1 has no cross-epoch session inventory.
- The Reserve flow is gated on `options.shard`. When omitted (default in
  the mock-provider test), every file is treated as a winner. Real
  importers will pass a `MemoryShardActor` from `bundle.openShardPool`.

## Commands Run

```text
pnpm install
pnpm --filter @c3-oss/prosa-importers-v2 typecheck    # clean
pnpm --filter @c3-oss/prosa-importers-v2 test         # 8 tests / 2 files
pnpm --filter @c3-oss/prosa-importers-v2 build        # dist/ emitted
pnpm --filter @c3-oss/prosa-importers-v2 lint         # clean

pnpm build                                              # 11/11 turbo
just typecheck                                          # 11/11 turbo
just test-all                                           # 11/11 turbo
just lint-all                                           # 11/11 turbo
pnpm test:conformance                                   # 15 tests pass
git diff --check                                        # clean
```

## Data / Security Evidence

- `GraphResolver` rejects cross-epoch parent resolution unless a caller
  supplies a `PriorEpochSessionInventory` (current-epoch policy from
  CQ-033). Tests cover the inline / edge-derived / fixup-derived /
  unresolved arms.
- The orchestrator passes the EpochHandle's tmp dir to the projection
  segment writer; bytes land under the bundle root and the segment
  ref's path passes Lane 1's CQ-031 path-safety check.
- `runCompileImports` exits without sealing when a shard reports
  `serialization_error` (thrown error rather than silent skip).

## Known Risks

- Real provider importers are not yet present; the per-provider
  parsing logic for Codex/Claude/Cursor/Gemini/Hermes will need
  separate iterations and per-provider fixture corpora.
- Idempotency (I2) is provable only against real importers; the mock
  test asserts the orchestrator shape, not the deduplication property.
- Cross-epoch session fixups are emitted but Lane 1 has no
  `session_fixup_v2` projection segment writer; landing one is
  scope for a follow-up iteration when the first cross-epoch real
  case appears.

## Reviewer Notes

- This iteration intentionally ships a **partial Lane 2** — the contract
  + orchestrator + GraphResolver — so per-provider importer iterations
  can plug in incrementally.
- `prosa-importer-specialist` review of the contract and orchestrator
  shape should land before the first real provider port.
