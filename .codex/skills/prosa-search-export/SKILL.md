---
name: prosa-search-export
description: Search, session listing, analytics, TUI/MCP read surfaces, and export guidance for prosa. Use when modifying src/services/search.ts, src/services/sessions.ts, src/services/analytics.ts, src/services/export, CLI output commands, FTS5 search_docs behavior, Markdown exports, Parquet/DuckDB analytics, or user-facing read/query flows.
---

# Prosa Search Export

Use this skill for read surfaces built on the canonical store. Search, exports, and Parquet/DuckDB analytics are derived views, not sources of truth. See `docs/architecture/search-engines.md` for FTS5 vs. Tantivy semantics, `docs/architecture/bundle-format.md` for `search_docs` and analytics view layout, and `docs/recipes/duckdb.md` for query examples.

## Search Rules

- Query `search_docs` joined to `search_docs_fts`; keep metadata in `search_docs`, not only inside FTS text.
- Default user queries should be escaped for FTS5 unless an explicit raw mode is added or used.
- Preserve useful filters by session, project, timestamp, role, tool name, canonical tool type, and field kind.
- Index conversation text, commands, paths, error previews, summaries, and relevant metadata.
- Do not push full large tool outputs into FTS. Store full bytes in CAS and index previews or classified chunks only.

## Session Listing

- Keep list and count filters consistent.
- Prefer stable columns for CLI output: timestamp, source tool, session ID, model, message/tool counts, cwd, and title.
- Validate source filters against known tools: `cursor`, `codex`, `claude`, `gemini`.

## Markdown Export

- Export should be readable and provenance-preserving.
- Include source tool, prosa session ID, source session ID, start/end, cwd, git branch, model span, and timeline confidence.
- Render messages in timeline order and show tool calls near their owning messages when possible.
- For large outputs, show preview and object references instead of dumping every byte.
- If timeline confidence is low, make that visible in the export.

## Analytics Views (dual home)

- The five analytics views (`session_facts`, `tool_usage_facts`, `error_facts`, `model_usage`, `project_activity`) live in **both** SQLite (migration v3 in `src/core/schema/sql/003_analytics_views.ts`, queried by MCP and any direct `bundle.db` consumer) and DuckDB (created at query time in `createAnalyticsViews` inside `src/services/export/parquet.ts`, queried by the `prosa analytics` CLI and `prosa query duckdb`).
- Keep column names and semantics aligned across the two dialects when changing a view. Dialect-specific differences (`date_diff` vs. `julianday`, `ILIKE` vs. `LIKE`) live behind the `dialect` param of `buildAnalyticsSql` in `src/services/analytics.ts`.

## Parquet and DuckDB

- `prosa export parquet` should generate derived analytics files from canonical SQLite tables, not from Markdown or FTS output.
- `prosa query duckdb` should query exported Parquet files and keep SQLite/CAS as the source of truth.
- `queryDuckDbParquet()` exposes one view per canonical table plus the analytics views.
- `prosa analytics sessions|tools|errors|models|projects` should use the fixed SQL in `src/services/analytics.ts` (DuckDB dialect) and preserve `table|json|csv` output support.
- `--refresh` on analytics commands should call `exportBundleParquet()` before querying; without it, keep the existing missing-Parquet guidance.
- Do not export `search_docs_fts`; export `search_docs` metadata instead.
- Keep the MVP layout simple: one Parquet file per canonical table.
- Keep `docs/recipes/duckdb.md` and README examples aligned with analytics views and commands.

## MCP read surface

- Six tools total: `search`, `sessions`, `tool_calls`, `analytics`, `artifact`, `compile`. Five are read-only; `compile` is dual-mode (status without args, mutating import with args).
- `analytics` runs the same five reports as the CLI, but against SQLite views via `runAnalyticsReportFromBundle` — no DuckDB at runtime.
- `sessions` folds list/get/markdown export via `format=summary|detail|markdown`.
- `tool_calls` folds command audit and file-history (`path_substring`) into one tool.

## Validation

- Add focused tests for escaping FTS queries, snippets, filters, low-confidence timeline display, and large output previews.
- For analytics changes, add or update tests around `test/services/parquet.test.ts`, `test/services/sqlite-analytics-views.test.ts`, `test/cli/analytics.test.ts`, and `test/mcp/tools.test.ts`.
- Compare exported Markdown snapshots only when the output is intentionally stable.
- Use temp stores and fixture imports; avoid relying on host history.
