# @c3-oss/prosa

## 0.6.0

### Minor Changes

- This release lands four threads of work.

  **Performance**: tuning SQLite pragmas and switching the bundle to a 16 KiB `page_size` cut `compile-all` wall time by 37% (520s → 329s); the Codex importer was split into a `prepare`/`apply` pair so the async parse + CAS file writes can run concurrently across a slice while each domain transaction still commits one file at a time.

  **Health checks**: a new `prosa doctor` command audits the bundle in two phases — a quick set (manifest, schema, SQLite integrity, foreign keys, search index status + drift, recent import errors, stuck batches, data sanity counts) and an opt-in `--deep` set (`PRAGMA integrity_check` plus a configurable CAS hash sample); the command supports `--strict`, `--checks <list>` filtering, and distinct exit codes for opened-but-failed vs unopenable bundles. As a side effect, `compile-all` now reaps abandoned `import_batches` at the start of each run and the pino-pretty logger renders multi-line JSON.

  **Tooling**: the project now extends the shared `@c3-oss/config-{biome,typescript,tsup,vitest}` packages instead of inlining its configuration, keeping only the prosa-specific deltas; adopting the shared Biome config produced a one-time repo-wide formatting sweep.

  **CLI output**: `printRows` is now width-aware (it honors `process.stdout.columns`, shrinks the widest column until the row fits, and truncates cells with a single `…`), each command exposes a `ColumnSet` with a curated default and a `--columns default|all|csv` flag, and JSON/CSV output stays complete. The most visible change is `prosa analytics sessions`, which dropped from 15 columns to 9 by default; `--columns all` brings the full set back.

## 0.5.0

### Minor Changes

- Performance tuning, MCP+CLI overwrite/metrics, analytics expansion, docs/tests

## Unreleased

### Minor Changes

- Consolidate the MCP surface from 10 tools to 6 (`search`, `sessions`,
  `tool_calls`, `analytics`, `artifact`, `compile`). `compile` is now dual-mode:
  with no args it returns a status snapshot; with `source` (and optional
  `sessions_path`) it runs the import. `sessions` folds the previous list / get
  / markdown export tools via a `format` param. `analytics` exposes the same
  five built-in reports as the CLI, backed by SQLite views.
- Lift the analytics views (`session_facts`, `tool_usage_facts`, `error_facts`,
  `model_usage`, `project_activity`) into the SQLite schema as views (migration
  v3). The DuckDB/Parquet path keeps its mirror of the same shape, so MCP
  reads run against SQLite without spinning up DuckDB.
- Tantivy index rebuilds are now incremental by default. New
  `search_docs.rowid > last_indexed_rowid` rows are added on top of the
  existing segments; full rebuild only on first run, schema fingerprint
  mismatch, or `prosa index tantivy --full`. Writer runs with 4 threads
  and a 300 MB heap. Migration v4 adds `last_indexed_rowid` and
  `schema_fingerprint` to `search_index_status`. Steady-state Tantivy
  rebuild on a 250k-doc bundle: 12 s → ~0.5 s.
- Parquet export tuned to `COMPRESSION zstd, COMPRESSION_LEVEL 1,
ROW_GROUP_SIZE 100000`. Same wall time as the previous snappy default,
  ≈half the on-disk size, no read-side regression on the analytics
  queries we measured. See `docs/roadmap/parquet-export-perf.md`.

## 0.4.0

### Minor Changes

- Add an MCP session_metrics tool for session audits.

## 0.3.2

### Patch Changes

- Initialize MCP stores before tool calls.

## 0.3.1

### Patch Changes

- Various code improvements

## 0.3.0

### Minor Changes

- MCP tool to compile sessions and code quality gates

## 0.2.0

### Minor Changes

- Performance improvements, logging and a new CLI

## 0.1.1

### Patch Changes

- Fix the published `prosa` bin so it runs correctly when launched through `npx`.
