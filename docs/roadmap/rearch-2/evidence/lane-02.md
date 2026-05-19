# Lane Evidence

Lane: 02 - Importers
Status: active WIP. The user rejected the Lane 2 re-scope and directed full
per-record projection across all 5 providers + fixture corpora +
cross-provider idempotency conformance. CodexProvider full per-record
projection landed at `d302bc6` (TurnV2 + MessageV2 + ContentBlockV2 +
ToolCallV2 + ToolResultV2 + EventV2 on canonical schema fields, no
`as never` casts). **This iteration** lands ClaudeProvider full per-record
projection: MessageV2 + ContentBlockV2 (including `thinking` →
`hidden_by_default`) from `message.content[]`; ToolCallV2 from `tool_use`
blocks with canonical_tool_type mapping + inferred command/path/query;
ToolResultV2 from `tool_result` blocks linked by `source_call_id` with
bounded preview; EventV2 from `system`/`progress`/operational records. The
v1 user-vs-tool-role heuristic carries over: a user record whose content is
only `tool_result` blocks is re-classified as role `tool`. The
`LogicalImportUnit` contract, `GraphResolver`, and `runCompileImports`
orchestrator landed at `004107c`. Lane 1 was accepted at `4792457`, lifting
the `CQ-044` containment gate. `fc66925`/`8c0ba5f`/`aa88079`/`c496bac` landed
minimal slices. `58cca83` landed CQ-072/CQ-073 CLI help-smoke closeout.
`d302bc6` landed Codex full per-record projection + closed CQ-075/CQ-076.
Focused importer gates pass at 37 tests / 7 files. `CQ-074` remains open
because the same full-projection work still has to land for
Cursor/Gemini/Hermes plus fixture corpora and the cross-provider idempotency
conformance.
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
- [ ] **Per-provider importers (codex, claude, cursor, gemini, hermes).**
  CodexProvider and ClaudeProvider both ship **full per-record projection**.
  - Codex: TurnV2 (from `turn_context`), MessageV2 + ContentBlockV2 (from
    `response_item:message`), ToolCallV2 (from `response_item:function_call`,
    with command/cwd/path/query inferred from arguments), ToolResultV2 (from
    `response_item:function_call_output`, with bounded `preview`), EventV2
    (from `event_msg`).
  - Claude: MessageV2 + ContentBlockV2 (from `message.content`, including
    `thinking` blocks tagged `hidden_by_default`), ToolCallV2 (from `tool_use`
    blocks with `canonical_tool_type` mapping, `source_call_id`,
    `command`/`path`/`query` inferred), ToolResultV2 (from `tool_result`
    blocks linked back to the matching `tool_use` by `source_call_id` with
    bounded `preview` and `status='success' | 'error'`), EventV2 (from
    `system`/`progress`/etc. records). User messages whose content is
    only `tool_result` blocks are re-classified as role `tool`.
  - Cursor is opaque-bytes only. Gemini and Hermes have minimal slices. Full
    projection still pending across Cursor/Gemini/Hermes.
- [ ] `apps/cli/test/cli/compile-v2.test.ts` exists with subprocess tests for
  successful single-provider execution, bad-provider rejection, and
  `compile-all-v2` execution. The CQ-072 WIP adds `compile-v2 --help` and
  `compile-all-v2 --help` smokes. The CLI surface is committed at `58cca83`;
  Lane 2 acceptance still depends on the `CQ-074` scope decision or the
  original full importer contract.
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
pnpm --filter @c3-oss/prosa-importers-v2 typecheck    # clean (Codex + Claude full per-record projection)
pnpm --filter @c3-oss/prosa-importers-v2 test         # 37 tests / 7 files (GraphResolver 5, orchestrator 3, CodexProvider 7 incl. CQ-074 full-projection canonical-field assertions, ClaudeProvider 7 incl. CQ-068 spawned edges + CQ-074 full-projection canonical-field assertions, CursorProvider 4, GeminiProvider 5, HermesProvider 6)
pnpm --filter @c3-oss/prosa-importers-v2 build        # dist/ emitted
pnpm --filter @c3-oss/prosa-importers-v2 lint         # clean
pnpm --filter @c3-oss/prosa lint                      # pass after CQ-073 closeout
pnpm --filter @c3-oss/prosa typecheck                 # pass after current CLI WIP
pnpm --filter @c3-oss/prosa exec vitest run test/cli/compile-v2.test.ts
                                                          # pass, 5 tests including CQ-072 help smokes

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
