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
- Kept in sync by triggers (`search_docs_ai`, `search_docs_ad`,
  `search_docs_au`) — every insert/update/delete on `search_docs`
  propagates automatically.
- Inline updates fire during normal `prosa compile` runs.
  `--defer-index` disables the triggers for the duration of the import
  and the user must run `prosa index fts5` afterwards to repopulate.
- Always-available; no extra rebuild step needed for normal use.

When to prefer FTS5: every default case. CLI usage, single-shot scripts,
small to medium bundles.

```bash
prosa search "terraform error"
prosa search "package.json" --engine fts5
```

## Tantivy (optional sidecar)

- On-disk index lives at `<bundle>/search/tantivy/`.
- Built and managed via the Rust binding in `src/services/search/`.
- Rebuilt **fully** at the end of every successful `prosa compile` run
  when `importedAny === true` — see
  [Import pipeline](./import-pipeline.md). Failure is logged but does not
  abort compile; the canonical SQLite/CAS layer is already committed.
- Manual rebuild: `prosa index tantivy`.
- Status surfaced in `search_index_status` (`engine='tantivy'`):
  `missing`, `ready`, `stale`, `building`, `failed`.

When to prefer Tantivy:

- High-concurrency reads (MCP server with multiple agent clients,
  shared bundles).
- Fuzzy / typo-tolerant search.
- Better ranking and snippets across very large result sets.

```bash
prosa index tantivy
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
| Normal `prosa compile` (no `--defer-index`) | Inline via triggers | Full rebuild after compile if `importedAny` |
| `prosa compile --defer-index` | Skipped during import | Full rebuild after compile if `importedAny` |
| `prosa index fts5` | Full repopulate from `search_docs` | Untouched |
| `prosa index tantivy` | Untouched | Full rebuild from `search_docs` |
| Re-run with no source changes (`importedAny === false`) | Triggers no-op | Skipped |

A future optimization is incremental Tantivy/Parquet rebuilds keyed off
the import delta. The current full-rebuild model is acceptable while
bundle size is in the gigabyte range.
