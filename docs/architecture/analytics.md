# Analytics

`prosa v1 analytics` runs five fixed reports — `sessions`, `tools`, `errors`,
`models`, `projects` — by querying canonical bundle data through DuckDB views
that read exported Parquet files. The same reports also run directly against
the SQLite bundle via equivalent analytics views.

Implementation: `packages/prosa-core/src/services/export/parquet.ts`,
`packages/prosa-core/src/services/analytics.ts`,
`apps/cli/src/cli/commands/analytics.ts`,
`apps/cli/src/cli/commands/query.ts`.

## Parquet export

`exportBundleParquet({ bundlePath, outDir? })` writes one `.parquet` file per
canonical table under `<bundle>/parquet/` (override with `--out`). Each table
is written via DuckDB's `COPY (...) TO '...' (FORMAT parquet, COMPRESSION
zstd, COMPRESSION_LEVEL 1, ROW_GROUP_SIZE 100000)`. Alongside the files, a
`manifest.json` records `exported_at`, `source_db`, `schema_version`,
`parser_version`, and per-table row counts.

The canonical tables exported are: `objects`, `source_files`,
`import_batches`, `raw_records`, `import_errors`, `uncertainties`, `projects`,
`sessions`, `turns`, `events`, `messages`, `content_blocks`, `tool_calls`,
`tool_results`, `artifacts`, `edges`, `search_docs`. Schema and source-of-truth
rules for those tables live in
[`architecture/bundle-format.md`](./bundle-format.md).

## Analytics views

`queryDuckDbParquet` creates one DuckDB view per canonical table backed by
`read_parquet(...)`, then recreates five analytics views with the same
semantics as the SQLite views shipped in migration v3:

| View | Grain | Key columns |
|---|---|---|
| `session_facts` | one row per session | `session_id`, `source_tool`, `project_id`, `project_name`, `source_session_id`, `start_ts`, `end_ts`, `duration_seconds`, `model_first`, `model_last`, `message_count`, `user_message_count`, `assistant_message_count`, `turn_count`, `tool_call_count`, `tool_result_count`, `tool_error_count`, `tool_duration_ms`, `timeline_confidence`, `source_file_path`, `title` |
| `tool_usage_facts` | one row per tool call (joined with rollup of its results) | `tool_call_id`, `session_id`, `tool_name`, `canonical_tool_type`, `command`, `path`, `query`, `timestamp_start`, `timestamp_end`, `call_duration_seconds`, `call_status`, `result_status`, `is_error`, `exit_code`, `result_duration_ms`, `tool_result_count`, `preview` |
| `error_facts` | one row per tool-result error, import error, or uncertainty | `error_id`, `error_category`, `source_tool`, `session_id`, `timestamp`, `tool_name`, `status`, `exit_code`, `message`, `preview`, `entity_type`, `entity_id` |
| `model_usage` | one row per `(source_tool, project, model)` rollup over sessions/turns/messages | `model`, `session_count`, `turn_count`, `observation_count`, `message_count`, `first_seen_ts`, `last_seen_ts` |
| `project_activity` | one row per `(source_tool, project)` | `project_name`, `project_path`, `first_session_ts`, `latest_session_ts`, `session_count`, `low_confidence_session_count`, `turn_count`, `message_count`, `tool_call_count`, `tool_result_count`, `tool_error_count`, `search_doc_count` |

The view names and the projected columns are the stable contract for
external dashboards and ad-hoc queries; the underlying tables can evolve as
long as the view shapes stay compatible.

## CLI surface

`prosa v1 analytics <report>` runs the named report and prints rows. Shared
flags on every subcommand:

- `--store <path>` — bundle directory (defaults to `~/.prosa`).
- `--parquet-dir <path>` — read Parquet from a non-default location.
- `--refresh` — call `exportBundleParquet` before querying.
- `--local` — read the local bundle even if this store is remote-authoritative.
- `--source <tool>` — `cursor` | `codex` | `claude` | `gemini` | `hermes`.
- `--since <iso>` / `--until <iso>` — inclusive lower / exclusive upper time bounds.
- `--limit <n>` — row cap (clamped to 500; default 50).
- `--output-format <fmt>` — `interactive` | `table` | `json` | `csv`.
- `--columns <list>` — column subset (or `default` / `all`).

Per-report flags:

| Report | Extra flags |
|---|---|
| `sessions` | `--project <text>` |
| `tools` | `--tool-name <name>`, `--canonical-type <type>`, `--errors-only` |
| `errors` | `--tool-name <name>`, `--category <category>` |
| `models` | `--model <name>` |
| `projects` | `--project <text>` |

`runAnalyticsReport` builds parameterized SQL per dialect; the SQLite path
(`runAnalyticsReportFromBundle`) uses the same templates against the bundle's
analytics views.

## Ad-hoc queries

`prosa v1 query duckdb '<sql>'` opens the Parquet directory, creates the same
table views and analytics views, and runs raw SQL. It accepts `--store`,
`--parquet-dir`, `--local`, and `--output-format`.

Copy-pasteable recipes live in [`recipes/duckdb.md`](../recipes/duckdb.md).

## Where to look first

| Task | Entry point |
|---|---|
| Add or change a report SQL template | `packages/prosa-core/src/services/analytics.ts` |
| Add or change an analytics view | `createAnalyticsViews` in `packages/prosa-core/src/services/export/parquet.ts` and the matching SQLite migration |
| Add a CLI flag or column set | `apps/cli/src/cli/commands/analytics.ts` |
| Ad-hoc DuckDB analysis | `apps/cli/src/cli/commands/query.ts` and [`recipes/duckdb.md`](../recipes/duckdb.md) |
