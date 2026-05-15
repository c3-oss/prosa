# Bundle format

A `prosa` bundle is a local directory that holds the canonical projection of
imported agent histories alongside the raw bytes they were derived from. By
default it lives at `~/.prosa`; override with `--store <path>` or
`PROSA_STORE`.

This document is the authoritative reference for the on-disk layout, the
SQLite schema, and the rules that keep raw, projection, and derived layers in
sync. It is implemented by `packages/prosa-core/src/core/bundle.ts`, `packages/prosa-core/src/core/schema/`, and
`packages/prosa-core/src/core/cas/`.

## On-disk layout

```text
<bundle>/
  manifest.json          # bundle metadata (version, parser, schema, hash alg)
  prosa.sqlite           # canonical catalog (all tables below)
  prosa.lock             # advisory lock taken by mutating commands
  objects/
    blake3/
      ab/cd/<hash>.zst   # CAS objects, fanned out by the first 4 hex chars
  raw/
    sources/             # zstd-compressed copies of original source files
  search/
    tantivy/             # optional sidecar full-text index (built on demand)
  parquet/               # derived analytics snapshots (one .parquet per canonical table)
  exports/               # ad-hoc exports (Markdown, etc.)
```

`manifest.json` is written at `prosa init` and refreshed on every
`openBundle` if `parser_version` advanced. Its shape is:

```json
{
  "version": 1,
  "parser_version": "<package version>",
  "schema_version": 2,
  "created_at": "<ISO8601>",
  "hash_alg": "blake3",
  "default_compression": "zstd"
}
```

## Three layers

| Layer | Where it lives | Source of truth? |
|---|---|---|
| Raw immutable | `raw/sources/`, `objects/`, `source_files`, `raw_records`, `import_batches`, `import_errors`, `uncertainties` | Yes |
| Canonical projection | `projects`, `sessions`, `turns`, `events`, `messages`, `content_blocks`, `tool_calls`, `tool_results`, `artifacts`, `edges` | No — regenerable from raw |
| Derived read surfaces | `search_docs`, `search_docs_fts`, `search_index_status`, SQLite analytics views (`session_facts`, `tool_usage_facts`, `error_facts`, `model_usage`, `project_activity`), `search/tantivy/`, `parquet/`, DuckDB analytics views, `exports/` | No — disposable |

Rule: the projection and derived layers can always be rebuilt from the raw
layer. Importer fixes ship as a re-projection, not a re-import. Everything
the projection needs to be reconstructed must live in `raw_records` and the
objects they reference.

## Content-addressed storage

Every byte string with potential reuse — raw lines, decoded JSON, tool
output, file contents, source-file copies — is stored once in the CAS:

- Hash: BLAKE3 over the uncompressed bytes; `object_id` is `blake3:<hex>`.
- Compression: zstd when worth it (`packages/prosa-core/src/core/cas/compress.ts` decides per
  buffer); the on-disk path is `objects/blake3/<aa>/<bb>/<hash>.zst` where
  `<aa><bb>` are the first 4 hex chars of the hash.
- Dedup: identical content produces the same `object_id` regardless of which
  importer staged it.
- Provenance is preserved separately: a single `object_id` may be referenced
  from many `raw_records`, `messages`, `tool_results`, `artifacts`, etc.

`source_files` uses SHA-256 (`content_hash`) instead of BLAKE3, because that
column is the natural key for idempotent file registration and predates
the importer-side staging API. The `object_id` column on `source_files`
points at the BLAKE3-keyed CAS copy.

The CAS exposes a per-importer staging API in `packages/prosa-core/src/core/cas/index.ts`:

```ts
const pending = createPendingObjects();
const objId = stageBytes(pending, rawLine);     // sync; returns the ObjectId
//                       stageJson, stageText follow the same shape
await flushPendingObjects(bundle, pending);     // bulk: one SELECT, parallel
                                                // writeFile, INSERT OR IGNORE
```

The legacy `putBytes` / `putText` / `putJson` helpers (one shot,
auto-commit) remain for callers outside the importer hot path.

## Schema

All tables live in `prosa.sqlite`. SQL definitions are in
`packages/prosa-core/src/core/schema/sql/001_init.ts` (v1) and `002_search_index_status.ts`
(v2). Changes go in new migration files, never by editing existing ones.

### Raw layer

#### `objects`
Hash-addressed bytes referenced by everything else.

| Column | Type | Notes |
|---|---|---|
| `object_id` | TEXT PK | `blake3:<hex>` |
| `hash_alg`, `hash` | TEXT | Always `blake3` today; second index on `(hash_alg, hash)` |
| `size_bytes` | INTEGER | Original (uncompressed) size |
| `compressed_size_bytes` | INTEGER nullable | Set when `compression='zstd'` |
| `compression` | TEXT | `zstd` or `none` |
| `mime_type`, `encoding` | TEXT nullable | Best-effort; not authoritative |
| `storage_path` | TEXT | Relative to bundle root |
| `created_at` | TEXT | ISO 8601 |

#### `source_files`
One row per imported source file, idempotent on
`(source_tool, path, size_bytes, mtime, content_hash)`.

| Column | Notes |
|---|---|
| `source_file_id` | Deterministic from tool + path + content hash |
| `source_tool` | `codex`, `claude`, `gemini`, `cursor`, `hermes` |
| `path` | Absolute path on the user's machine |
| `file_kind` | `jsonl`, `json`, `sqlite`, `tool_result`, `memory`, `blob`, … |
| `size_bytes`, `mtime`, `content_hash` | Natural-key components (SHA-256) |
| `object_id` | Preserved copy in CAS (BLAKE3) |
| `discovered_at` | When prosa first saw this file |
| `workspace_hint` | Optional source-specific hint (e.g. Cursor workspace id) |

#### `raw_records`
Reprocessing foundation. Every projected row carries a `raw_record_id` back
to one of these.

| Column | Notes |
|---|---|
| `raw_record_id` | Deterministic from source_file + locator + content |
| `source_file_id`, `source_tool` | FK + redundant tool column |
| `record_kind` | `jsonl_line`, `json_pointer`, `sqlite_meta`, `sqlite_blob`, `external_file` |
| `ordinal`, `line_no`, `json_pointer`, `native_id` | Locator fields filled per record kind |
| `raw_object_id` | Bytes of the record (always set) |
| `decoded_json_object_id` | Canonical JSON, when distinct from the raw bytes |
| `parser_status` | `ok`, `partial`, `failed` |
| `confidence` | `high`, `medium`, `low` |
| `import_batch_id` | FK |

UNIQUE on `(source_file_id, ordinal, raw_object_id)` so re-imports are
no-ops at the record level.

`decoded_json_object_id` is a deliberate per-importer choice. See
[Import pipeline](./import-pipeline.md#the-decoded_json_object_id-rule) for
the matrix.

#### `import_batches`, `import_errors`, `uncertainties`
- `import_batches`: one row per `prosa compile <provider>` invocation —
  parser version, status, JSON counts.
- `import_errors`: parse failures, missing files, broken references; a
  single bad file does not abort the batch.
- `uncertainties`: low-confidence projections (e.g. inferred Cursor timeline
  ordering, ambiguous parent edges). Read with `entity_type` + `entity_id`.

### Canonical projection

#### `projects`
Logical project identity. Natural key:
`(source_tool, source_project_id)`. `canonical_path` and `path_hash` are
filled when the real filesystem path can be resolved (Gemini
`.project_root`, Codex `cwd`, Claude `cwd`); slug-derived directory names
are not treated as reversible.

#### `sessions`
| Column | Notes |
|---|---|
| `session_id` | Internal UUID |
| `source_tool`, `source_session_id` | UNIQUE pair |
| `project_id`, `parent_session_id` | FK |
| `is_subagent` | 0/1 |
| `agent_role`, `agent_nickname` | e.g. Codex `explorer`, Claude agent type |
| `title`, `summary` | Optional |
| `start_ts`, `end_ts`, `cwd_initial`, `git_branch_initial`, `model_first`, `model_last`, `status` | Source metadata |
| `timeline_confidence` | `high` \| `medium` \| `low` (CHECK constraint) |
| `raw_record_id` | Primary metadata record |

Indexes on `source_tool`, `start_ts`, `project_id`, `parent_session_id`.

#### `turns`
Per-turn execution context (mostly Codex; other importers use it sparingly).
`(session_id, ordinal)` indexed.

#### `events`
The unified event log. Every projection of a tool's record produces at
least one event:

| Column | Notes |
|---|---|
| `event_type` | Coarse: `message`, `tool_call`, `tool_result`, `progress`, `system_operational`, `attachment`, `compaction`, `patch`, `exec`, … |
| `source_type` | The tool's native record name (e.g. `event_msg.exec_command_end`) |
| `subtype` | Optional sub-discriminator |
| `actor` | `user`, `assistant`, `tool`, `system`, `cli` |
| `payload_object_id` | CAS pointer for the normalized JSON payload |
| `raw_record_id` | Always set |
| `confidence` | `high`/`medium`/`low` |
| `is_derived` | 1 when prosa inferred the event vs. the source emitting it |

Indexes on `(session_id, ordinal)` and `(event_type, subtype)`.

#### `messages`
`role` is a closed set:
`'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'`.
`'operational'` distinguishes Claude-style `type: "system"` events from
real system prompts. Indexes on `(session_id, ordinal)` and `role`.

#### `content_blocks`
Per-message content fragments. `block_type` covers `text`, `input_text`,
`output_text`, `tool_use`, `tool_result`, `thinking`, `image`, `attachment`,
`diff`, `summary`, etc. Either `text_object_id` (for large content) or
`text_inline` (for small) is set, never both meaningfully. `visibility`
controls Markdown export defaults: `default`, `hidden_by_default`,
`audit_only`.

#### `tool_calls` and `tool_results`
Joined on either `tool_call_id` (when prosa matched them) or
`source_call_id` (the tool's native id, e.g. Claude `tool_use.id`, Codex
`call_id`, Gemini `toolCalls[].id`). `canonical_tool_type` collapses
provider-specific names: `Bash`/`Shell`/`run_shell_command` → `shell`,
`Read`/`read_file` → `read_file`, `Edit`/`replace` → `edit_file`, etc.
`tool_results.is_error`, `exit_code`, `duration_ms`, and the three
`*_object_id` columns (stdout, stderr, output) cover the audit surface.

#### `artifacts`
Out-of-band content: large tool outputs, image-bearing PDF pages,
file-history snapshots, project memory files. `kind` is open-ended.
`object_id` holds the bytes; `text_object_id` holds extracted text where
available.

#### `edges`
Cross-entity graph. `(src_type, src_id, dst_type, dst_id, edge_type)` is
UNIQUE. Edge taxonomy:

```text
parent_of, calls, returns, spawned, contains, produced, consumed,
derived_from, summarizes, compacts, same_as, refers_to
```

`source` is always one of `explicit`, `path_inferred`,
`timestamp_inferred`, `content_inferred`. `confidence` echoes the
source quality. Inferred edges that should not be trusted blindly should
also produce an `uncertainties` row.

### Derived read surfaces

#### `search_docs` + `search_docs_fts`
`search_docs` is the indexable view. `field_kind` partitions text by
purpose: `message_text`, `user_prompt`, `assistant_text`, `command`,
`command_output_preview`, `error`, `file_path`, `diff`, `summary`,
`artifact_text`, `tool_args`, `tool_result`. The FTS5 virtual table
mirrors `search_docs` via `content='search_docs'` and
`tokenize='unicode61 remove_diacritics 2'`. Triggers
(`search_docs_ai/ad/au`) keep them in sync for direct writes outside of
compile. During `prosa compile` the triggers are disabled and the FTS5
index is rebuilt in bulk at the end — see
[Import pipeline](./import-pipeline.md) and
[Search engines](./search-engines.md).

#### `search_index_status`
Tracks the FTS5 and Tantivy engines:
`(engine, status, source_doc_count, indexed_doc_count, updated_at, error_message)`.
`status ∈ {missing, ready, stale, building, failed}`. See
[Search engines](./search-engines.md).

#### Parquet and DuckDB analytics
`prosa export parquet` writes one `.parquet` file per canonical table under
`parquet/`, plus a manifest. These files are derived snapshots and can be
deleted or rebuilt from SQLite/CAS.

`prosa query duckdb` creates one DuckDB view per canonical Parquet file and
also creates query-time analytics views:

```text
session_facts, tool_usage_facts, error_facts, model_usage, project_activity
```

`prosa analytics sessions|tools|errors|models|projects` runs fixed reports over
those views. The reports can use `--refresh` to rebuild Parquet before
querying, but they do not make Parquet authoritative. See
[`docs/recipes/duckdb.md`](../recipes/duckdb.md) for examples.

## Idempotency keys

| Table | Natural key | Behavior |
|---|---|---|
| `objects` | `object_id` (BLAKE3) | `INSERT OR IGNORE`; identical bytes are a no-op |
| `source_files` | `(source_tool, path, size_bytes, mtime, content_hash)` | Re-running compile over the same file is a no-op |
| `raw_records` | `(source_file_id, ordinal, raw_object_id)` | UNIQUE; same record from same file at same offset deduped |
| `sessions` | `(source_tool, source_session_id)` | UNIQUE |
| `projects` | `(source_tool, source_project_id)` | UNIQUE |
| `edges` | `(src_type, src_id, dst_type, dst_id, edge_type)` | UNIQUE |

The compile path is wired so re-running `prosa compile-all` twice in a row
produces zero new rows, zero new objects, and skips the post-import
Tantivy/Parquet rebuilds (`importedAny === false`). See the
[Import pipeline](./import-pipeline.md) for the runtime path.

## Migrations

Migrations are in `packages/prosa-core/src/core/schema/sql/NNN_*.ts`, applied in numeric order
by `runMigrations()` in `packages/prosa-core/src/core/schema/migrate.ts`. The current schema
version is `PROSA_SCHEMA_VERSION` in `packages/prosa-core/src/core/version.ts`. `openBundle`
refuses to open a bundle whose schema is ahead of the running code.

To add a column or table:

1. Write a new `NNN_<name>.ts` exporting the raw SQL.
2. Wire it into the migrate.ts loader.
3. Bump `PROSA_SCHEMA_VERSION`.
4. Update this doc's schema section.

Never edit a previous migration's SQL — bundles created against the old
version would diverge.
