# Lane Evidence

Lane: 02 - Importers
Status: active WIP (minimal provider stubs for Codex, Claude, Cursor, Gemini,
and Hermes landed; CLI WIP under `CQ-071`; full transcript projection
pending). The
`LogicalImportUnit` contract, `GraphResolver`, and `runCompileImports`
orchestrator landed at `004107c`. Lane 1 was later accepted at
`4792457`, lifting the `CQ-044` containment gate. `fc66925` landed
the first per-provider slice (minimal CodexProvider). `8c0ba5f`
added CQ-067 governance reconcile and a minimal ClaudeProvider.
`aa88079` added Claude subagent spawned-edge projection and a minimal
CursorProvider. `c496bac` fixed Cursor's stable logical key and added minimal
GeminiProvider and HermesProvider slices. Focused importer gates pass at 35
tests across 7 files. `CQ-071` remains open for the `compile-v2` CLI WIP.
Owner: Ralph
Commit range: `004107c` (orchestrator + GraphResolver), `4792457`
(Lane 1 acceptance / `CQ-044` lifted), `fc66925` (minimal
CodexProvider), `8c0ba5f` (minimal ClaudeProvider + CQ-067 closeout),
`aa88079` (Claude spawned edges + minimal Cursor + CQ-068/CQ-069 closeout),
`c496bac` (Cursor stable key + minimal Gemini/Hermes + CQ-070 closeout)

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
  remain partial.** Codex, Claude Code, and Cursor now have minimal
  slices. Claude Code additionally preserves subagent spawned edges
  (CQ-068) with deterministic edge_ids and an end-to-end test through
  the orchestrator + sealEpoch. Cursor is opaque-bytes only (no
  SQLite row decoding yet). Full transcript/event/tool-call/message
  projection remains pending across all providers. Gemini and Hermes
  remain unstarted.
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
pnpm --filter @c3-oss/prosa-importers-v2 typecheck    # clean after CQ-068/CQ-069 closeout
pnpm --filter @c3-oss/prosa-importers-v2 test         # 24 tests / 5 files (GraphResolver + orchestrator + CodexProvider + ClaudeProvider w/ spawned edges + CursorProvider)
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

- Real provider importers remain partial. Codex has a minimal slice; the full
  Codex transcript/event/tool-call projection plus Claude/Cursor/Gemini/Hermes
  parsing logic still need separate iterations and per-provider fixture corpora.
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
