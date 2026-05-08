# Import pipeline

`prosa compile <provider>` and `prosa compile-all` walk a provider's local
session tree and produce a fully-indexed bundle. This doc describes how
that pipeline is structured today, the contracts each importer must honor,
and the per-provider trade-offs.

Implementation: `src/cli/commands/compile.ts`, `src/core/ingest/`,
`src/core/cas/index.ts`, `src/importers/<provider>/`.

## Pipeline phases

For each `(provider, sessions-path)`:

1. **Discovery** — walk the provider tree without trusting auxiliary
   indexes. Codex and Claude scan `*.jsonl`; Gemini scans
   `chats/session-*.json`; Cursor scans `**/store.db`.
2. **Source-file registration** — `registerSourceFile()` in
   `src/core/ingest/idempotency.ts` looks up
   `(source_tool, path, size, mtime)` and short-circuits if the row exists.
   On miss it hashes the file (SHA-256), preserves the bytes under
   `raw/sources/<blake3>.zst`, and inserts the `source_files` row.
   **Already-known files are skipped entirely** — the natural key is also
   the idempotency key.
3. **Per-record staging** — for each line / blob / JSON-pointer entry, the
   importer parses, calls `stageBytes` / `stageJson` / `stageText`
   (synchronous, in-memory dedup), and accumulates pending domain rows
   referencing the returned `ObjectId`s.
4. **CAS flush** — `await flushPendingObjects(bundle, pending)` runs once
   per file: bulk `SELECT object_id … WHERE object_id IN (…)` to find
   existing rows, parallel `writeFile` (concurrency 16) for the missing
   ones, and `INSERT OR IGNORE` rows in a single batch.
5. **Domain transaction** — one `transactional(db, () => …)` per file
   inserts every `raw_records`, `events`, `messages`, `content_blocks`,
   `tool_calls`, `tool_results`, `artifacts`, `edges`, and `search_docs`
   row in a single SQLite commit.
6. **Per-batch bookkeeping** — `import_batches.counts_json` and
   `import_errors` rows are written.

Before the import loop starts, `runCompileImports` calls
`disableFts5Triggers(bundle)` so that `search_docs` inserts inside the
per-file domain transaction do not pay the cost of incremental FTS5
tokenization. A `finally` block re-enables them.

The analytics views (`session_facts`, `tool_usage_facts`, `error_facts`,
`model_usage`, `project_activity`) are SQLite views created by migration
v3 (`src/core/schema/sql/003_analytics_views.ts`). They are pure SELECTs,
so no rebuild step is needed after compile — every query against them
sees the latest canonical state. The DuckDB-side equivalents in
`createAnalyticsViews` (`src/services/export/parquet.ts`) mirror the
same column names so SQLite (MCP / CLI) and DuckDB (Parquet) reads stay
in lockstep.

After all providers in a single `runCompiles(...)` invocation finish:

7. **FTS5 rebuild** — when `importedAny === true`, `rebuildFts5Index(bundle)`
   issues `INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')`
   inside a single transaction (much faster than per-row trigger updates)
   and sets `search_index_status` to `ready`.
8. **Tantivy rebuild** — when `importedAny === true`, the still-open bundle
   has its Tantivy sidecar rebuilt via `rebuildTantivyIndex(bundle)`.
   The default path is **incremental**: only `search_docs.rowid >
   last_indexed_rowid` are added (with a `deleteDocumentsByTerm` for safety).
   The first rebuild after upgrade or after a schema fingerprint change
   falls back to a full re-index. The writer uses 4 threads with a 300 MB
   heap. See [Search engines](./search-engines.md).
9. **Parquet export** — after `closeBundle(bundle)` (DuckDB cannot
   coexist with an open `better-sqlite3` writer),
   `exportBundleParquet({ bundlePath })` rewrites every canonical table
   under `parquet/`. Files are written with `COMPRESSION zstd` (level 1)
   and `ROW_GROUP_SIZE 100000` — same wall time as the previous snappy
   default but ≈half the on-disk size. Tuning details and benchmarks in
   [`docs/roadmap/parquet-export-perf.md`](../roadmap/parquet-export-perf.md).

Index rebuild failures are logged at error level but do not throw; the
canonical SQLite/CAS layer is already committed and the user can re-run
`prosa index fts5`, `prosa index tantivy`, or `prosa export parquet`
manually.

## CAS staging contract

`src/core/cas/index.ts` is structured around the observation that
auto-commit per record is the dominant import cost. Every importer follows
the same shape:

```ts
const pending = createPendingObjects();

for (const record of file) {
  const rawId = stageBytes(pending, record.rawBytes);
  // ...optionally stageJson/stageText for derived payloads
  pendingDomain.push({ rawId, /* …other ids… */ });
}

await flushPendingObjects(bundle, pending);

transactional(bundle.db, () => {
  for (const row of pendingDomain) {
    insertRawRecord.run(/* … */);
    // …other inserts…
  }
});
```

Two invariants matter:

- `flushPendingObjects` runs **before** the synchronous SQLite transaction.
  better-sqlite3 transactions are sync; filesystem writes that happen
  inside them serialize. The flush also writes files **before** inserting
  their rows, so a crash mid-flush leaves orphan files (acceptable; same
  hash → same path → next run dedups) rather than rows pointing at missing
  files.
- `ensureDir(absoluteDir)` is process-cached. The CAS fanout creates up to
  65 536 leaf directories; calling `mkdir(... { recursive: true })` per
  staged object measurably hurts cold imports.

## The `decoded_json_object_id` rule

For each `raw_records` row prosa can store two CAS objects: the raw bytes
(`raw_object_id`, always set) and a canonical JSON projection
(`decoded_json_object_id`, optional). Whether to populate the second
depends on whether the importer or any later consumer reads that JSON back
out:

| Importer | `decoded_json_object_id` for parsed records | Why |
|---|---|---|
| Codex | `NULL` | Each JSONL line **is** the JSON; no consumer reads it back |
| Claude | `NULL` | Same |
| Gemini | populated | Source is one big JSON file; per-message payloads are genuinely distinct objects worth caching |
| Cursor | populated | The importer reads the decoded JSON back during the same pass (`src/importers/cursor/index.ts`) |

Halving the CAS writes for the two heaviest importers cut cold-import time
substantially. Existing rows from older imports remain untouched —
`NULL` is allowed by the schema.

## Idempotency contract

Re-running `prosa compile-all` against an unchanged source tree must
produce zero new rows, zero new files, and skip the post-import
Tantivy/Parquet rebuilds. The keys that enforce this:

| Layer | Key | Where |
|---|---|---|
| File | `(source_tool, path, size, mtime, content_hash)` | `source_files` UNIQUE |
| Record | `(source_file_id, ordinal, raw_object_id)` | `raw_records` UNIQUE |
| Object | `object_id` (BLAKE3) | `objects` PK + `INSERT OR IGNORE` |
| Session | `(source_tool, source_session_id)` | `sessions` UNIQUE |
| Edge | `(src_type, src_id, dst_type, dst_id, edge_type)` | `edges` UNIQUE |

A modified source file produces a new `source_file_id` (different
`content_hash`) but reuses every CAS object whose bytes happen to match —
provenance is preserved separately in `raw_records`.

## Per-importer notes

- **Codex** (`src/importers/codex/`): preserves the
  `type` / `timestamp` / `payload` envelope. `session_meta`,
  `turn_context`, `response_item`, `event_msg` map to sessions, turns,
  events/messages/tool calls, and operational events respectively. Tool
  calls and outputs match on `call_id`. Subagent sessions are linked via
  `payload.source.subagent.thread_spawn.parent_thread_id`. See
  [Codex source format](../sources/codex.md).
- **Claude Code** (`src/importers/claude/`): scans `*.jsonl` directly;
  `sessions-index.json` is treated as a hint, never the source of truth.
  `uuid` / `parentUuid` / `agentId` / `isSidechain` /
  `sourceToolAssistantUUID` populate the message graph and subagent
  edges. `type: "system"` is treated as `role='operational'`, not a
  system prompt. `tool-results/` artifacts and `memory/*.md` files are
  imported as `artifacts`. See
  [Claude Code source format](../sources/claude-code.md).
- **Gemini** (`src/importers/gemini/`): chat files are treated as
  snapshots — duplicate `sessionId` across files becomes versions of one
  logical session. `.project_root` populates `projects.canonical_path`
  when present. See [Gemini source format](../sources/gemini.md).
- **Cursor** (`src/importers/cursor/`): reads each `store.db` read-only
  (`mode=ro&immutable=1`), classifies blobs (JSON / text / protobuf-ish),
  and projects the JSON ones. Timeline ordering depends on undecoded
  protobuf root state, so projected sessions get
  `timeline_confidence='low'` until decoding improves. See
  [Cursor source format](../sources/cursor.md).

## Critical files

| Path | Role |
|---|---|
| `src/cli/commands/compile.ts` | `compile <provider>` / `compile-all` driver, including post-import Tantivy/Parquet step |
| `src/core/cas/index.ts` | CAS, staging API, `ensureDir` cache |
| `src/core/cas/compress.ts`, `src/core/cas/hash.ts` | zstd policy, BLAKE3 |
| `src/core/ingest/idempotency.ts` | `registerSourceFile`, `preserveRawSourceBytes` |
| `src/core/ingest/batch.ts` | `import_batches` lifecycle and counts |
| `src/core/db.ts` | `prepare`, `transactional` helpers |
| `src/importers/<provider>/index.ts` | The four provider importers |
| `src/services/indexing.ts` | FTS5 trigger toggles, `rebuildFts5Index`, `rebuildTantivyIndex`, `markIndexesAfterImport` |
| `src/services/export/parquet.ts` | Post-compile Parquet refresh |

## Constraints worth remembering

- Cross-provider parallel imports against a single bundle are **not
  supported**. SQLite WAL allows concurrent readers but writers
  serialize, and the per-process `ensuredDirs` cache is shared.
- Tantivy and Parquet rebuilds are **full**, not incremental. The cost is
  proportional to bundle size, not import delta. Acceptable while bundles
  stay in the gigabyte range.
- The `compile-all` driver runs providers sequentially. A single
  provider's failure logs an `import_errors` row but does not abort the
  others.
- An importer that crashes mid-file leaves committed
  `source_files`/`objects` rows but no domain rows for that file
  (transactional boundary). The next run reuses the
  `source_files`/`objects` rows and writes the missing domain rows.
