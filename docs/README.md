# `prosa` documentation

Reference for the prosa bundle, importers, search surfaces, analytics, and the sync server. Skim the top-level [`README.md`](../README.md) first for the user-facing CLI; the docs below cover how the system works inside and what each agent CLI's on-disk format looks like.

## Architecture

- [`architecture/bundle-format.md`](./architecture/bundle-format.md) — on-disk layout, manifest, content-addressed storage, full SQLite schema, idempotency keys, and migration rules.
- [`architecture/import-pipeline.md`](./architecture/import-pipeline.md) — how `prosa compile <provider>` and `prosa compile-all` walk source trees, stage CAS objects, commit one transaction per file, and rebuild Tantivy and Parquet at the end.
- [`architecture/search-engines.md`](./architecture/search-engines.md) — FTS5 default versus Tantivy sidecar: when each is the right choice, rebuild semantics, writer configuration, and `search_index_status`.
- [`architecture/analytics.md`](./architecture/analytics.md) — `prosa analytics` reports, Parquet export configuration, the five stable DuckDB views (`session_facts`, `tool_usage_facts`, `error_facts`, `model_usage`, `project_activity`), and the ad-hoc `prosa query duckdb` surface.
- [`architecture/server-sync.md`](./architecture/server-sync.md) — `apps/api` host, Better Auth multi-tenancy, the one-way promotion protocol, object store adapters, Postgres schema split, remote-authoritative reads, and the E2E Docker harness.

## Source formats

One reference per importer covering directory layout, record format, identity rules, reading recipes (`jq` / `sqlite3` / `rg`), and importer notes.

- [`sources/codex.md`](./sources/codex.md) — `~/.codex/sessions/` JSONL.
- [`sources/claude-code.md`](./sources/claude-code.md) — `~/.claude/projects/` JSONL + artifacts.
- [`sources/cursor.md`](./sources/cursor.md) — `~/.cursor/chats/**/store.db` SQLite.
- [`sources/gemini.md`](./sources/gemini.md) — `~/.gemini/tmp/` JSON.
- [`sources/hermes.md`](./sources/hermes.md) — `~/.hermes/state.db` + `~/.hermes/sessions/`.

## Recipes

- [`recipes/duckdb.md`](./recipes/duckdb.md) — copy-pasteable DuckDB queries over canonical Parquet tables and analytics views.

## Future work

- [`../ROADMAP.md`](../ROADMAP.md) — Parquet features, server-sync hardening, and the multi-lane web platform spec.
- [`roadmap/web-platform/`](./roadmap/web-platform/) — eight-lane spec for the browser product surface and authenticated console.

## Where to look first

| Task | Start here |
|---|---|
| Add or modify a column / table | `architecture/bundle-format.md` |
| Change how an importer normalizes a source | the matching `sources/*.md` and `architecture/import-pipeline.md` |
| Debug a slow `compile` | `architecture/import-pipeline.md` |
| Decide between FTS5 and Tantivy | `architecture/search-engines.md` |
| Add or extend an analytics report | `architecture/analytics.md` |
| Build a new analytics query | `recipes/duckdb.md` |
| Work on the sync server, auth, or remote reads | `architecture/server-sync.md` |
| Inspect a tool's history without prosa | `sources/<tool>.md` recipes |
