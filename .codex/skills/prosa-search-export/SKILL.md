---
name: prosa-search-export
description: Search, session listing, analytics, TUI/MCP read surfaces, and export guidance for prosa. Use when modifying packages/prosa-core/src/services/{search,sessions,analytics,indexing,export}, apps/cli/src/tui, CLI output commands, FTS5/Tantivy behavior, Markdown exports, Parquet/DuckDB analytics, or user-facing read/query flows.
---

# Prosa Search Export

Use this skill for read surfaces built on the canonical store. Search, exports, and Parquet/DuckDB analytics are derived views, not sources of truth. See `docs/architecture/search-engines.md` for FTS5 vs. Tantivy semantics, `docs/architecture/bundle-format.md` for `search_docs` and analytics view layout, and `docs/recipes/duckdb.md` for query examples.

## Layout

- Services: `packages/prosa-core/src/services/{search.ts,sessions.ts,analytics.ts,indexing.ts,tool_calls.ts,compile.ts,doctor.ts}` and the export bundle in `packages/prosa-core/src/services/export/{markdown.ts,parquet.ts}`.
- CLI output ergonomics: `apps/cli/src/cli/{output.ts,columns.ts}` (column sets, width-aware tables).
- TUI: `apps/cli/src/tui/App.tsx` plus `use-visible-window.ts`. Three Ink screens — sessions list, session detail, search — all owned by `App.tsx`.
- MCP: `packages/prosa-core/src/mcp/{server.ts,tools.ts,guidance.ts}`.

## Search Rules

- Query `search_docs` joined to `search_docs_fts`; keep metadata in `search_docs`, not only inside FTS text.
- Default user queries escape FTS5 metacharacters unless an explicit raw mode is requested.
- Preserve filters by session, project, timestamp, role, tool name, canonical tool type, and field kind.
- Index conversation text, commands, paths, error previews, summaries, and relevant metadata.
- Do not push full large tool outputs into FTS. Store full bytes in CAS and index previews or classified chunks only.

## Indexing

- `packages/prosa-core/src/services/indexing.ts` owns the Tantivy index lifecycle: multi-threaded ingest, incremental updates keyed by `search_doc_id`, and reconciliation against the SQLite source of truth. Keep writers single-instance per bundle and reuse existing schema fields rather than introducing parallel ones.

## Session Listing

- Keep list and count filters consistent.
- Prefer stable columns for CLI output: timestamp, source tool, session ID, model, message/tool counts, cwd, title.
- Validate source filters against known tools: `codex`, `claude`, `cursor`, `gemini`, `hermes`.

## Markdown Export

- Export should be readable and provenance-preserving.
- Include source tool, prosa session ID, source session ID, start/end, cwd, git branch, model span, and timeline confidence.
- Render messages in timeline order and show tool calls near their owning messages when possible.
- For large outputs, show preview and object references instead of dumping every byte.
- If timeline confidence is low, make that visible in the export.

## Analytics Views (dual home)

The five analytics views — `session_facts`, `tool_usage_facts`, `error_facts`, `model_usage`, `project_activity` — live in **both** SQLite (migration v3 in `packages/prosa-core/src/core/schema/sql/003_analytics_views.ts`, used by MCP and direct `bundle.db` consumers) and DuckDB (created at query time by `createAnalyticsViews` in `packages/prosa-core/src/services/export/parquet.ts`, used by the `prosa analytics` CLI and `prosa query duckdb`).

Keep column names and semantics aligned across the two dialects when changing a view. Dialect-specific differences (`date_diff` vs. `julianday`, `ILIKE` vs. `LIKE`) live behind the `dialect` param of `buildAnalyticsSql` in `packages/prosa-core/src/services/analytics.ts`.

## Parquet and DuckDB

- `prosa export parquet` generates derived analytics files from canonical SQLite tables, not from Markdown or FTS output. Config: zstd level 1, row group 100k — see `packages/prosa-core/src/services/export/parquet.ts`.
- `prosa query duckdb` queries exported Parquet and keeps SQLite/CAS as the source of truth. `queryDuckDbParquet()` exposes one view per canonical table plus the five analytics views.
- `prosa analytics sessions|tools|errors|models|projects` runs the fixed SQL in `packages/prosa-core/src/services/analytics.ts` (DuckDB dialect) and preserves `table|json|csv` output.
- `--refresh` on analytics commands calls `exportBundleParquet()` before querying; without it, keep the existing missing-Parquet guidance.
- Table output goes through `printRows` in `apps/cli/src/cli/output.ts`, which is width-aware (truncates to `process.stdout.columns ?? 200` with a single-char `…`). Each command picks a default column subset via a `ColumnSet` in `apps/cli/src/cli/columns.ts`; `--columns default|all|csv` is the public knob. `json`/`csv` always emit every column the service returns — never gate full data on `--columns`.
- Do not export `search_docs_fts`; export `search_docs` metadata instead.
- Keep the MVP layout simple: one Parquet file per canonical table.
- Keep `docs/recipes/duckdb.md` and README examples aligned with the analytics views and commands.

## MCP read surface

- Six tools total: `search`, `sessions`, `tool_calls`, `analytics`, `artifact`, `compile`. Five are read-only; `compile` is dual-mode (status without args, mutating import with args).
- Three prompts: `find_file_history`, `investigate_prior_work`, `audit_tool_failures`.
- `analytics` runs the same five reports as the CLI, but against SQLite views via `runAnalyticsReportFromBundle` — no DuckDB at runtime.
- `sessions` folds list/get/markdown export via `format=summary|detail|markdown`.
- `tool_calls` folds command audit and file-history (`path_substring`) into one tool.

## Validation

- Add focused tests for FTS query escaping, snippets, filters, low-confidence timeline display, and large output previews.
- For analytics changes, add or update tests around `packages/prosa-core/test/services/parquet.test.ts`, `packages/prosa-core/test/services/sqlite-analytics-views.test.ts`, `apps/cli/test/cli/analytics.test.ts`, and `packages/prosa-core/test/mcp/tools.test.ts`.
- Compare exported Markdown snapshots only when the output is intentionally stable.
- Use temp stores and fixture imports; avoid relying on host history.
