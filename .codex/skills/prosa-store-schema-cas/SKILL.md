---
name: prosa-store-schema-cas
description: Bundle, SQLite schema, raw preservation, content-addressed storage, and idempotency guidance for the local prosa bundle. Use when changing packages/prosa-core/src/core (bundle, schema, CAS, ingest, IDs), migrations, raw_records, objects, source_files, or normalized storage tables.
---

# Prosa Store Schema CAS

Use this skill when touching the local canonical store. The authoritative reference is `docs/architecture/bundle-format.md` (full schema, CAS rules, idempotency keys); pair with `docs/architecture/import-pipeline.md` for how `compile` writes into it. Raw bytes are the source of truth, normalized tables are rebuildable projections, search/export indexes are derived.

The remote schema (`packages/prosa-db/src/schema/`) and the cross-driver object store (`packages/prosa-storage/`) are **out of scope here** — they belong to `$prosa-server-sync`.

## Layout

- Bundle owner: `packages/prosa-core/src/core/bundle.ts`.
- SQLite handles, helpers, and migrations: `packages/prosa-core/src/core/db.ts` and `packages/prosa-core/src/core/schema/{migrate.ts,sql/}`.
- CAS (BLAKE3 + zstd): `packages/prosa-core/src/core/cas/`.
- Ingest helpers: `packages/prosa-core/src/core/ingest/`.
- Domain IDs and types: `packages/prosa-core/src/core/domain/`.
- Limits and errors: `packages/prosa-core/src/core/{limits.ts,errors.ts}`.

## Store Model

The bundle is local-first:

```text
manifest.json
prosa.sqlite
objects/blake3/ab/cd/<hash>.zst
raw/sources/
exports/
```

Keep this layering intact:

1. Raw immutable layer: `source_files`, `raw_records`, `objects`, `import_batches`, `import_errors`.
2. Canonical projection: `projects`, `sessions`, `turns`, `events`, `messages`, `content_blocks`, `tool_calls`, `tool_results`, `artifacts`, `edges`.
3. Derived indexes and analytics views: `search_docs`, `search_docs_fts` (FTS5 triggers disabled during `prosa compile`, bulk-rebuilt at the end), and the five analytics views (`session_facts`, `tool_usage_facts`, `error_facts`, `model_usage`, `project_activity`) created by migration v3.

## Schema Rules

- Preserve raw source bytes before or alongside projection writes.
- Do not make Markdown, search docs, or Parquet-style outputs authoritative.
- Add schema fields only when they model stable cross-importer semantics or preserve required provenance.
- Use explicit confidence fields when a relationship or timeline is inferred.
- Do not treat Claude `type: "system"` as a system prompt; it is operational unless importer evidence says otherwise.
- Use `edges` for graph relationships such as parent message, spawned subagent, tool call/result, and artifact links.
- Migrations live under `packages/prosa-core/src/core/schema/sql/` and run through `migrate.ts`; add the next-numbered file rather than editing applied ones.

## CAS Rules

- Store large text, JSON payloads, tool outputs, diffs, and raw records through `putBytes`, `putText`, or `putJson`.
- Keep BLAKE3 object IDs stable and zstd compression transparent.
- Deduplication must never erase provenance: many records may point to the same object.
- Keep previews short; large outputs belong in objects and artifacts.

## Idempotency

- Reimporting the same source must not grow sessions, messages, tool calls, tool results, or objects unexpectedly.
- Use deterministic IDs from `packages/prosa-core/src/core/domain/ids.ts`.
- Preserve uniqueness constraints for source files and raw records.
- Add or update tests that import the same fixture repeatedly when changing ingest behavior.
