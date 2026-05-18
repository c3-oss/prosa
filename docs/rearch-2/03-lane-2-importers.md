# Lane 2 — Importers

## Goal

Ship the `LogicalImportUnit` model, the `Reserve`-before-parse flow, the `GraphResolver` pre-Parquet-seal step (handles Codex deferred parent linking and similar in-epoch cross-file resolutions), and the five provider importers (Codex, Claude Code, Cursor, Gemini, Hermes). After this lane, `prosa compile` and `prosa compile-all` work against bundle v2 with the same idempotency guarantees as v1 — but without the SQLite WAL writer lock and with explicit cross-provider deduplication of logical sessions.

## Depends on

- Lane 1 (Local store) complete. This lane consumes the shard-actor command surface, pack writers, and epoch lifecycle.

## Deliverables

- New package `packages/prosa-importers-v2` containing:
  - `LogicalImportUnit` assembly pipeline.
  - `ReserveSessionCommand` flow against Lane 1's shard actor.
  - `GraphResolver` with `LateBindingIndex`.
  - One importer module per provider: `codex/`, `claude/`, `cursor/`, `gemini/`, `hermes/`.
  - `runCompileImports` orchestrator (replaces the v1 function of the same name).
- Updated CLI commands (added alongside v1, not replacing): `prosa compile-v2 <provider>`, `prosa compile-all-v2`. v1 commands kept until Lane 10.
- Fixture corpora under `test/fixtures/providers-v2/` derived from current v1 fixtures.
- Idempotency conformance test covering all 5 providers.

## Tasks

1. **`LogicalImportUnit` type + assembly.** The unit groups one or more source files into one logical session/artifact/project. For Codex/Claude/Cursor, 1 file → 1 unit. For Hermes/Gemini, 2+ files can fold into 1 unit per logical session.
2. **`ReserveSessionCommand` flow.** Before any full parse, each importer worker derives the logical session key (cheap identification pass) and calls `Reserve` on the owning shard actor. Only the reservation winner proceeds to full parse + CAS staging + projection assembly.
3. **`GraphResolver` with `LateBindingIndex`.** Pre-Parquet-seal step that walks pending `spawned` edges (Codex/Claude subagents) and sets `SessionV2.parent_session_id` when the parent exists in the current epoch or any prior committed epoch. Cross-epoch leftovers emit `SessionFixupV2`.
4. **Codex importer.** Port v1 `compileCodex` to bundle v2 API. Replace direct SQLite inserts with shard-actor commands + projection-row appends. Replace `linkSubagentParents` global UPDATE with `GraphResolver`.
5. **Claude Code importer.** Same port. Preserve UUID-based `parent_message_id` resolution within a file (local map). Preserve subagent edges.
6. **Cursor importer.** Port. Keep `timeline_confidence = 'low'` projection. SQLite `mode=ro&immutable=1` read still works.
7. **Gemini importer.** Port. Two snapshots of the same `sessionId` fold into one `LogicalImportUnit` via the merge layer.
8. **Hermes importer.** Port. SQLite + JSONL dual-source merge in the identification pass; merge winner determined per tie-breaker (max message_count, JSONL wins ordering on tie, SQLite wins metadata).
9. **`runCompileImports` v2 orchestrator.** Replaces the v1 function with:
   - Sweep stale `tmp/epoch-*` from prior crashes.
   - Per-provider sequential or parallel (configurable; default sequential to preserve current behavior).
   - Per-file `Reserve` → parse → CAS stage → projection emit.
   - After all providers done: `GraphResolver` run, then `sealEpoch`.

## Concrete types and schemas

### `LogicalImportUnit`

```ts
// packages/prosa-importers-v2/src/types.ts
export type LogicalImportUnit = {
  unit_id: string
  source_tool: SourceTool
  logical_kind: 'session' | 'artifact' | 'project' | 'source_only'

  source_file_ids: string[]           // 1+ source files contributing to this unit
  raw_record_ids: string[]

  projection: CanonicalProjectionDraft

  merge: {
    merge_strategy:
      | 'single_source'
      | 'hermes_sqlite_plus_jsonl'
      | 'gemini_session_versions'
    selected_source_file_id?: string
    candidates?: Array<{
      source_file_id: string
      source_kind: string
      message_count?: number
      confidence: 'high' | 'medium' | 'low'
    }>
  }
}

export type CanonicalProjectionDraft = {
  projects: ProjectV2[]
  sessions: SessionV2[]
  turns: TurnV2[]
  events: EventV2[]
  messages: MessageV2[]
  content_blocks: ContentBlockV2[]
  tool_calls: ToolCallV2[]
  tool_results: ToolResultV2[]
  artifacts: ArtifactV2[]
  edges: EdgeV2[]
  search_docs: SearchDocV2[]
}
```

### Importer flow (canonical)

```ts
// Per provider:
async function importProvider(bundle: Bundle, root: string): Promise<ProviderSummary> {
  const filesToProcess = await discover(root)
  const summaries: FileSummary[] = []

  await mapConcurrent(filesToProcess, CONCURRENCY, async (filePath) => {
    // 1. Cheap identification: read header / filename / SQLite row key → derive logical key.
    const id = await cheapIdentify(filePath)
    const logicalKey = canonicalLogicalKey(provider, id)

    // 2. Reserve. Only winner does the work.
    const reservation = await bundle.shard.reserve('session', logicalKey, {
      ttlMs: 60_000,
      owner: { worker_id, source_tool: provider, source_file_ids: [filePath] },
    })
    if (reservation.kind === 'lost') {
      // Another worker is handling this logical session. Attach our source_file_id as candidate.
      await bundle.shard.attachCandidate(reservation.unit_id, filePath)
      return
    }

    // 3. Full parse + CAS staging + projection draft.
    const draft = await parseAndProject(provider, filePath, reservation.unit_id)

    // 4. Stage CAS objects and projection rows via bundle writers.
    await bundle.appendUnit(draft)

    // 5. Commit reservation.
    await bundle.shard.commit(reservation, draft.unit_id)

    summaries.push({ filePath, ok: true, counts: draft.counts })
  })

  return aggregate(summaries)
}
```

### `GraphResolver`

```ts
// packages/prosa-importers-v2/src/graph-resolver.ts
export type LateBindingIndex = {
  sessionsSeenThisEpoch: Set<SessionId>
  sessionsSeenPriorEpochs: SortedMmapTable<SessionId>
  spawnedEdges: EdgeV2[]   // edge_type='spawned', dst_type='session'
}

export async function resolveLateBindings(
  bundle: Bundle,
  pending: PendingEpochState,
): Promise<{ resolved: SessionV2[]; fixups: SessionFixupV2[] }> {
  const index = buildLateBindingIndex(pending, bundle.priorEpochIndex)

  for (const session of pending.sessions) {
    if (session.parent_session_id != null) {
      session.parent_resolution = 'inline'
      continue
    }
    const edge = index.spawnedEdges.find((e) => e.dst_id === session.session_id)
    if (!edge) {
      session.parent_resolution = 'unresolved'
      continue
    }
    if (index.sessionsSeenThisEpoch.has(edge.src_id) ||
        index.sessionsSeenPriorEpochs.contains(edge.src_id)) {
      session.parent_session_id = edge.src_id
      session.parent_resolution = 'edge_derived'
    } else {
      session.parent_resolution = 'unresolved'
      // No fixup yet — parent may appear in a later epoch.
    }
  }

  // Cross-epoch case: a prior-epoch session has 'unresolved' parent, and the parent
  // edge's src_id now resolves. Emit fixups.
  const fixups = generateCrossEpochFixups(bundle, index)

  return { resolved: pending.sessions, fixups }
}
```

### Hermes dual-source merge (illustrative)

```ts
// packages/prosa-importers-v2/src/hermes/merge.ts
export async function mergeHermesSession(
  sqliteRow: HermesSqliteSession,
  jsonlCandidates: HermesJsonlSession[],
): Promise<LogicalImportUnit> {
  // Tie-breaker 1: max(message_count) wins transcript body.
  const allCandidates = [
    { kind: 'sqlite', source_file_id: sqliteRow.source_file_id, count: sqliteRow.message_count },
    ...jsonlCandidates.map((c) => ({ kind: 'jsonl', source_file_id: c.source_file_id, count: c.message_count })),
  ]
  const winner = allCandidates.sort((a, b) => b.count - a.count)[0]

  // Tie-breaker 2: on tie, JSONL wins ordering, SQLite wins metadata (richer per-row fields).
  // Tie-breaker 3: hidden reasoning kept as visibility='hidden_by_default'.

  const projection = winner.kind === 'jsonl'
    ? buildFromJsonl(jsonlCandidates.find((c) => c.source_file_id === winner.source_file_id)!, sqliteRow)
    : buildFromSqlite(sqliteRow, jsonlCandidates)

  return {
    unit_id: makeUnitId('hermes', sqliteRow.source_session_id),
    source_tool: 'hermes',
    logical_kind: 'session',
    source_file_ids: allCandidates.map((c) => c.source_file_id),
    raw_record_ids: collectRawRecordIds(projection),
    projection,
    merge: {
      merge_strategy: 'hermes_sqlite_plus_jsonl',
      selected_source_file_id: winner.source_file_id,
      candidates: allCandidates.map((c) => ({
        source_file_id: c.source_file_id,
        source_kind: c.kind,
        message_count: c.count,
        confidence: 'high',
      })),
    },
  }
}
```

## Tests

| File | Asserts |
|---|---|
| `packages/prosa-importers-v2/test/idempotency.test.ts` | **Invariant I2**: run compile twice over the same fixture corpus → second run produces zero new rows, zero new objects, zero new packs. |
| `packages/prosa-importers-v2/test/canonical-graph.test.ts` | **Invariant I3**: Codex and Claude subagent edges produce `parent_session_id` resolution (`edge_derived`) when both files in same epoch. |
| `packages/prosa-importers-v2/test/reserve-concurrent.test.ts` | Two worker tasks try to `Reserve` the same Hermes session key from different source_files; only one wins; loser attaches its source_file_id as a candidate. |
| `packages/prosa-importers-v2/test/hermes-merge.test.ts` | SQLite row has 10 messages, JSONL has 15 → JSONL wins transcript body, SQLite contributes metadata. |
| `packages/prosa-importers-v2/test/gemini-versions.test.ts` | Same `sessionId` in two snapshot files → one `LogicalImportUnit`, latest snapshot wins. |
| `packages/prosa-importers-v2/test/cross-epoch-fixup.test.ts` | Subagent in epoch N, parent in epoch N+1 → epoch N's session has `parent_resolution='unresolved'`, epoch N+1 emits `SessionFixupV2` with `parent_resolution='fixup_derived'`. |
| `packages/prosa-importers-v2/test/codex/`, `claude/`, `cursor/`, `gemini/`, `hermes/` | Per-provider fixture corpora compile to expected row counts and entity shapes. |
| `apps/cli/test/compile-v2.test.ts` | `prosa compile-v2 codex` produces the same row counts as `prosa compile codex` on the same fixture (modulo v2-specific schema additions like `parent_resolution`). |

## Gate

The lane is complete when:

1. All test files above pass under `pnpm test --filter @prosa/importers-v2`.
2. `prosa compile-all-v2` against the standard fixture corpus produces:
   - Identical session / message / tool_call / tool_result counts to `prosa compile-all` (v1).
   - `parent_resolution` populated on every session (`inline`, `edge_derived`, `fixup_derived`, or `unresolved`).
   - No SessionFixupV2 emitted for in-epoch resolutions (the GraphResolver handles them inline).
3. Re-running `prosa compile-all-v2` on the same fixture is a no-op: zero new rows, zero CAS writes, zero pack writes, zero epoch seals.
4. **Invariants I2 and I3 pass.** I1 and I4 inherited from Lane 1.

## Risks

| Risk | Mitigation |
|---|---|
| `Reserve` TTL too short → spurious losses on slow parses | Default TTL 60 s; importer renews on long parse via heartbeat command. |
| Hermes merge wrong-winner edge case | Fixture corpus includes the known tricky cases: identical message_count, JSONL truncated vs complete, SQLite missing required metadata. |
| GraphResolver leaves `unresolved` for in-epoch-resolvable session | Lint check: after `runCompileImports`, count `unresolved` sessions; alert if non-zero in test fixtures. |
| Cross-provider parallel compile contention | Default to sequential per-provider (mirrors v1 behavior). Parallel mode behind `--experimental-parallel` flag. |

## Unblocks

Lane 3 (`04-lane-3-derived-layer.md`) — needs canonical projection rows committed in epochs to build Tantivy / session blobs / Parquet analytics.
