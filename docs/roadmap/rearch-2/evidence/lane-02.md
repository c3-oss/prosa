# Lane Evidence

Lane: 02 - Importers
Status: active WIP. The user rejected the Lane 2 re-scope and directed full
per-record projection across all 5 providers + fixture corpora +
cross-provider idempotency conformance. CodexProvider at `d302bc6`,
ClaudeProvider at `7eaed27`, GeminiProvider at `b660f44`, HermesProvider
at `8c1714f`. **This iteration** lands CursorProvider full per-record
projection over a real SQLite reader (`better-sqlite3` added as a
`prosa-importers-v2` workspace dep). The provider opens
`<root>/<ws>/<agent>/store.db` read-only via the file URI
(`file:...?mode=ro&immutable=1`, with a non-URI readonly fallback) and
emits: one RawRecordV2 per meta row (parser_status `parsed`) + one
per `blobs` row (`parsed` when the leading byte looks JSON-ish and
parse succeeds, otherwise `binary_only`); MessageV2 per JSON blob
with a `role` field (mapped through `mapCursorRole`); ContentBlockV2
per content item (`text`, `reasoning` → `hidden_by_default`
thinking, `redacted-reasoning` → `audit_only`, `tool-call`,
`tool-result`, unknown kinds preserved as `audit_only`); ToolCallV2
per `tool-call` item (canonical_tool_type covers Cursor tool names
`run_terminal_cmd`, `read_file`, `str_replace`, etc.); ToolResultV2
per `tool-result` item linked back by `source_call_id` with bounded
`preview`. Sessions are enriched from `meta` (`title`, `agent_role`,
`agent_nickname`, `start_ts`, `model_first|last`). For non-SQLite or
schemaless files (no `meta`/`blobs` tables), the provider emits one
fallback `binary_only` RawRecordV2 so the byte stream is still
preserved (invariant I1). The `LogicalImportUnit` contract,
`GraphResolver`, and `runCompileImports` orchestrator landed at
`004107c`. Lane 1 was accepted at `4792457`, lifting the `CQ-044`
containment gate. `fc66925`/`8c0ba5f`/`aa88079`/`c496bac` landed
minimal slices. `58cca83` landed CQ-072/CQ-073 CLI help-smoke
closeout. `d302bc6` landed Codex full per-record projection + closed
CQ-075/CQ-076. `7eaed27` landed Claude full per-record projection.
`b660f44` landed Gemini full per-record projection. `8c1714f` landed
Hermes full per-record projection. `af27eba` landed Cursor full
per-record projection over a real SQLite reader + closed
CQ-077/CQ-078. The Lane 2 closeout commit on top of this iteration
adds the shared fixture corpora under `test/fixtures/providers-v2/`
(one realistic-but-tiny corpus per provider mirroring its discovery
layout, including a Cursor JSON descriptor that the conformance test
materializes into a real SQLite store at runtime) and the
cross-provider idempotency conformance suite at
`test/conformance/providers-v2-idempotency.test.ts` (5 per-provider
cases asserting byte-identical projection ids across two runs against
the same on-disk layout, plus 1 Claude spawned-edge idempotency case;
floor row counts also enforced so an empty projection cannot silently
pass). `pnpm test:conformance` runs 21 tests / 2 files (15 leaves +
6 providers-v2 idempotency). `CQ-074`, `CQ-079`, and `CQ-080` are all
closed together with that commit; Lane 2 implementation contract is
complete and Lane 2 acceptance is pending Codex/governor/user
sign-off.
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
- [x] **Per-provider importers (codex, claude, cursor, gemini, hermes).**
  All five providers ship **full per-record projection**.
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
  - Gemini: MessageV2 + ContentBlockV2 (from `messages[].content`, supporting
    both string and `GeminiContentItem[]` forms), `thoughts[]` projected as
    extra `thinking` blocks at `hidden_by_default` visibility, ToolCallV2
    per `toolCalls[]` entry (Gemini-specific canonical_tool_type mapping
    covers `run_shell_command`/`read_file`/`replace`/etc.), ToolResultV2
    linked back by `source_call_id` with bounded `preview` rendered from
    the call's `result[]`, EventV2 (from `info`/`error`/unknown records).
  - Hermes: MessageV2 per envelope (`mapHermesRole` normalises `role` to
    `user`/`assistant`/`tool`/`system_prompt`/`developer`/`operational`;
    `session_meta` envelopes emit EventV2 instead of MessageV2); ContentBlockV2
    for rendered text plus hidden reasoning blocks (`reasoning` /
    `reasoning_content` / `reasoning_details` / `codex_reasoning_items` /
    `codex_message_items`); ToolCallV2 from each parsed `tool_calls[]` entry
    on the envelope; ToolResultV2 for `role: 'tool'` envelopes linked back
    by `tool_call_id` (the envelope's source_call_id). Both `.jsonl` and
    `session_*.json` snapshot files run through the same per-envelope
    projection helper.
  - Cursor: reads the real SQLite `store.db` via `better-sqlite3` (now a
    workspace dep on `prosa-importers-v2`). Emits one RawRecordV2 per meta
    row + one per `blobs` row (JSON blobs `parser_status='parsed'`, opaque
    blobs `binary_only`); MessageV2 per JSON blob with a `role` field
    (mapped through `mapCursorRole`: `user`/`assistant`/`tool`/
    `system_prompt`/`operational`); ContentBlockV2 per content item
    (`text`, `reasoning` → `hidden_by_default` thinking,
    `redacted-reasoning` → `audit_only`, `tool-call`, `tool-result`,
    unknown kinds preserved as `audit_only`); ToolCallV2 from `tool-call`
    items (`canonical_tool_type` mapping covers Cursor tool names like
    `run_terminal_cmd`, `read_file`, `str_replace`, etc.); ToolResultV2
    from `tool-result` items linked back by `source_call_id` with
    bounded `preview`. Sessions enriched with `title` /
    `agent_nickname` / `agent_role` / `start_ts` /
    `model_first|last` from `meta`. The provider also handles
    non-SQLite or schemaless files by emitting one fallback
    `binary_only` RawRecordV2 so I1 holds.
- [x] `apps/cli/test/cli/compile-v2.test.ts` exists with subprocess tests for
  successful single-provider execution, bad-provider rejection, and
  `compile-all-v2` execution plus `compile-v2 --help` and `compile-all-v2
  --help` smokes. The CLI surface committed at `58cca83`.
- [x] Invariant I2 (idempotency) validated against real fixture corpora.
  `test/fixtures/providers-v2/` holds one corpus per provider that mirrors
  the real discovery layout, and `test/conformance/providers-v2-idempotency.test.ts`
  runs each provider end-to-end twice against the same on-disk layout and
  asserts byte-identical projection ids per entity type (sessions, turns,
  messages, content_blocks, tool_calls, tool_results, events, edges,
  raw_records, source_files). Floor row counts also enforced so an empty
  projection cannot silently pass. `pnpm test:conformance` reports 21 tests
  / 2 files.
- [ ] Invariant I3 (canonical graph) — preserved via deterministic
  `EdgeV2.edge_id` derivation for Claude spawned edges, with one
  Claude-specific idempotency case in the conformance suite; full
  cross-provider graph unification still emerges as Lane 3+ derived layers
  consume the projection.

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
pnpm --filter @c3-oss/prosa-importers-v2 typecheck    # clean (all 5 providers ship full per-record projection)
pnpm --filter @c3-oss/prosa-importers-v2 test         # 40 tests / 7 files (GraphResolver 5, orchestrator 3, CodexProvider 7 incl. CQ-074 full-projection assertions, ClaudeProvider 7 incl. CQ-068 spawned edges + CQ-074 full-projection assertions, CursorProvider 5 incl. CQ-070 stable-key fix + CQ-074 SQLite full-projection assertions, GeminiProvider 6 incl. CQ-074 full-projection assertions, HermesProvider 7 incl. CQ-074 full-projection assertions)
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
