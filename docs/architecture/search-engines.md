# Search engines

`prosa` ships two full-text engines over the same source content. SQLite
FTS5 is the default and is always present in the bundle. Tantivy is an
optional sidecar that's faster and richer for concurrent or fuzzy queries.

Implementation: `src/services/indexing.ts`, `src/services/search/`,
`src/cli/commands/index.ts`, `src/cli/commands/search.ts`.

## What gets indexed

Both engines read from `search_docs`, the indexable projection populated
during `compile`. Each row is keyed by `(entity_type, entity_id)` and
classified by `field_kind`:

```text
message_text, user_prompt, assistant_text, system_prompt,
command, command_output_preview, error, file_path, diff,
summary, artifact_text, tool_args, tool_result
```

`field_kind` lets searches scope by purpose without resorting to text
heuristics. `tool_name` and `canonical_tool_type` are also stored for
filtering.

## FTS5 (default)

- Virtual table: `search_docs_fts` with `content='search_docs'` and
  `tokenize='unicode61 remove_diacritics 2'`.
- Triggers (`search_docs_ai`, `search_docs_ad`, `search_docs_au`)
  propagate every insert/update/delete on `search_docs` to the FTS5
  virtual table outside of compile.
- `prosa compile` always disables the triggers for the duration of the
  import loop and rebuilds the FTS5 index in bulk at the end via
  `INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')` —
  same shape as the Tantivy rebuild. Triggers are re-enabled before the
  command returns. The bundle ends up with FTS5 status `ready` and no
  drift between `search_docs` and `search_docs_fts`.
- `prosa index fts5` is a standalone recovery path that repopulates the
  index from `search_docs`.

When to prefer FTS5: every default case. CLI usage, single-shot scripts,
small to medium bundles.

```bash
prosa search "terraform error"
prosa search "package.json" --engine fts5
```

## Tantivy (optional sidecar)

- On-disk index lives at `<bundle>/search/tantivy/`.
- Built and managed via the Rust binding in `src/services/indexing.ts`.
- Rebuilt at the end of every successful `prosa compile` run when
  `importedAny === true`. The rebuild is **incremental** by default —
  only `search_docs.rowid > last_indexed_rowid` are added. The first
  rebuild after upgrading (or after a schema change) falls back to a
  full re-index automatically. See [Import pipeline](./import-pipeline.md).
  Failure is logged but does not abort compile.
- The writer runs with **4 threads** and a **300 MB heap budget** for both
  full and incremental paths.
- Manual full rebuild: `prosa index tantivy --overwrite`. Plain
  `prosa index tantivy` follows the incremental rules.
- Checkpoint state lives in `search_index_status`:
  - `last_indexed_rowid` — highest `search_docs.rowid` reflected in the
    on-disk segments.
  - `schema_fingerprint` — sha256 of the canonical schema definition;
    a mismatch forces a full rebuild on the next run.
- Status field on the same row: `missing`, `ready`, `stale`, `building`,
  `failed`.

When to prefer Tantivy:

- High-concurrency reads (MCP server with multiple agent clients,
  shared bundles).
- Fuzzy / typo-tolerant search.
- Better ranking and snippets across very large result sets.

```bash
prosa index tantivy           # incremental rebuild (default)
prosa index tantivy --overwrite    # force full rebuild (recovery / schema changes)
prosa search "terrafom paln" --engine tantivy
prosa mcp serve --search-engine tantivy
```

## Index status

`prosa index status` reads the `search_index_status` table:

```bash
prosa index status
prosa index status --output-format json
```

Output covers both engines, their `status`, `source_doc_count`,
`indexed_doc_count`, last `updated_at`, and any `error_message` from the
last failed build.

## Rebuild semantics

| Trigger | FTS5 | Tantivy |
|---|---|---|
| `prosa compile` | Triggers off during import; full rebuild after compile if `importedAny` | **Incremental** rebuild after compile if `importedAny` (full on first run, on schema change, or on missing index) |
| `prosa index fts5` | Full repopulate from `search_docs` | Untouched |
| `prosa index tantivy` | Untouched | Incremental rebuild from `search_docs` |
| `prosa index tantivy --overwrite` | Untouched | **Full** rebuild from `search_docs` |
| Re-run with no source changes (`importedAny === false`) | Skipped | Skipped |
| Direct writes to `search_docs` outside compile | Kept in sync via triggers | Marked stale until next rebuild |

Incremental Parquet rebuilds keyed off the import delta remain a future
optimization. The current full-Parquet-rewrite model is acceptable while
bundle size is in the gigabyte range.
