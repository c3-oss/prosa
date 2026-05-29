# `prosa` documentation

Reference for the prosa bundle, importers, search surfaces, analytics, and the sync server. Skim the top-level [`README.md`](../README.md) first for the user-facing CLI; the docs below cover how the system works inside and what each agent CLI's on-disk format looks like.

## Architecture

- [`architecture/bundle-format.md`](./architecture/bundle-format.md) — on-disk layout, manifest, content-addressed storage, full SQLite schema, idempotency keys, and migration rules.
- [`architecture/import-pipeline.md`](./architecture/import-pipeline.md) — how `prosa v1 compile <provider>` and `prosa v1 compile-all` walk source trees, stage CAS objects, commit one transaction per file, and rebuild Tantivy and Parquet at the end.
- [`architecture/search-engines.md`](./architecture/search-engines.md) — FTS5 default versus Tantivy sidecar: when each is the right choice, rebuild semantics, writer configuration, and `search_index_status`.
- [`architecture/analytics.md`](./architecture/analytics.md) — `prosa v1 analytics` reports, Parquet export configuration, the five stable DuckDB views (`session_facts`, `tool_usage_facts`, `error_facts`, `model_usage`, `project_activity`), and the ad-hoc `prosa v1 query duckdb` surface.
- [`architecture/server-sync.md`](./architecture/server-sync.md) — `apps/api` host, Better Auth multi-tenancy, the one-way promotion protocol, object store adapters, Postgres schema split, remote-authoritative reads, and the E2E Docker harness.

## Source formats

One reference per importer covering directory layout, record format, identity rules, reading recipes (`jq` / `sqlite3` / `rg`), and importer notes.

- [`sources/codex.md`](./sources/codex.md) — `~/.codex/sessions/` JSONL.
- [`sources/claude-code.md`](./sources/claude-code.md) — `~/.claude/projects/` JSONL + artifacts.
- [`sources/cursor.md`](./sources/cursor.md) — `~/.cursor/chats/**/store.db` SQLite.
- [`sources/gemini.md`](./sources/gemini.md) — `~/.gemini/tmp/` JSON.
- [`sources/hermes.md`](./sources/hermes.md) — `~/.hermes/state.db` + `~/.hermes/sessions/`.

## Transcript surfaces

The session transcript primitive backs CLI, TUI, and web rendering. All three read paths share the same shape so renderers behave consistently:

- `prosa v1 session show <id> [--format text|markdown|json]` — local transcript viewer in [`apps/cli/src/cli/commands/session.ts`](../apps/cli/src/cli/commands/session.ts). Reads the bundle directly; `--format json` emits the same `SessionTranscript` payload the TUI and remote API consume.
- `loadTranscript(bundle, sessionId, options?)` — programmatic API in [`packages/prosa-core/src/services/transcript.ts`](../packages/prosa-core/src/services/transcript.ts). Resolves CAS-backed text inline when small enough; oversize bodies remain reachable through `objectId` fields so callers can fetch on demand.
- `sessions.transcript` — tRPC procedure in [`apps/api/src/trpc/routers/reads/transcript.ts`](../apps/api/src/trpc/routers/reads/transcript.ts). Feeds the web detail page and is gated by the row-level verified projection manifest (see [`architecture/bundle-format.md`](./architecture/bundle-format.md#verified-projection-manifest-entity-types)).

## Recipes

- [`recipes/duckdb.md`](./recipes/duckdb.md) — copy-pasteable DuckDB queries over canonical Parquet tables and analytics views.

## Agent workflows

- [`agent-workflows/ralph-loop-governor.md`](./agent-workflows/ralph-loop-governor.md) — how to use Codex as governor for Claude Ralph Loop implementation runs, including prompt handoff, correction queues, reviewer subagents, and final gates.

## Future work

- [`../ROADMAP.md`](../ROADMAP.md) — Parquet features and server-sync hardening.

## Where to look first

| Task | Start here |
|---|---|
| Add or modify a column / table | `architecture/bundle-format.md` |
| Change how an importer normalizes a source | the matching `sources/*.md` and `architecture/import-pipeline.md` |
| Debug a slow `v1 compile` | `architecture/import-pipeline.md` |
| Decide between FTS5 and Tantivy | `architecture/search-engines.md` |
| Add or extend an analytics report | `architecture/analytics.md` |
| Build a new analytics query | `recipes/duckdb.md` |
| Work on the sync server, auth, or remote reads | `architecture/server-sync.md` |
| Render a single session locally (CLI/TUI) or programmatically | `prosa v1 session show` + `loadTranscript()` (above) |
| Render the session detail page in the web console | `sessions.transcript` tRPC procedure (above) |
| Work on the browser product surface | `../apps/web` |
| Run a governed Ralph Loop implementation workflow | `agent-workflows/ralph-loop-governor.md` |
| Inspect a tool's history without prosa | `sources/<tool>.md` recipes |
