# `prosa` documentation

Reference docs for the prosa bundle, importers, and search surfaces. Skim
[`README.md`](../README.md) first for the user-facing CLI surface; the
docs below cover how it works on the inside and what each agent CLI's
on-disk format looks like.

## Architecture

- [`architecture/bundle-format.md`](./architecture/bundle-format.md) —
  on-disk layout, manifest, content-addressed storage, full SQLite schema,
  idempotency keys, and migration rules.
- [`architecture/import-pipeline.md`](./architecture/import-pipeline.md) —
  how `prosa compile <provider>` and `prosa compile-all` walk source
  trees, stage CAS objects, commit one transaction per file, and rebuild
  Tantivy + Parquet at the end.
- [`architecture/search-engines.md`](./architecture/search-engines.md) —
  FTS5 (default) vs. Tantivy (sidecar): when each is the right choice,
  rebuild semantics, and `search_index_status`.

## Source formats

One reference per importer, covering directory layout, record format,
identity rules, reading recipes (`jq` / `sqlite3` / `rg`), and importer
notes.

- [`sources/codex.md`](./sources/codex.md) — `~/.codex/sessions/` JSONL
- [`sources/claude-code.md`](./sources/claude-code.md) — `~/.claude/projects/` JSONL + artifacts
- [`sources/cursor.md`](./sources/cursor.md) — `~/.cursor/chats/**/store.db` SQLite
- [`sources/gemini.md`](./sources/gemini.md) — `~/.gemini/tmp/` JSON

## Where to look first

| Task | Start here |
|---|---|
| Add or modify a column / table | `architecture/bundle-format.md` |
| Change how an importer normalizes a source | the matching `sources/*.md` and `architecture/import-pipeline.md` |
| Debug a slow `compile` | `architecture/import-pipeline.md` |
| Decide between FTS5 and Tantivy | `architecture/search-engines.md` |
| Inspect a tool's history without prosa | `sources/<tool>.md` recipes |
