# Legacy v2 bundle source

`prosa sync --legacy-bundle <path>` re-ingests sessions from a prosa v2
data bundle (typically `~/.prosa/`). It exists for one specific reason:
the v3 cutover dropped the v2 SQLite catalog and CAS object store from
the user's machine, but the original source files referenced by that
catalog had already been deleted by each upstream tool's own retention
policy. The bundle is the only surviving copy.

Imported by `internal/legacy/` (catalog + zstd reader) together with the
existing v3 per-agent importers (`internal/importers/{claudecode,codex,
cursor,gemini}`).

## When you need it

- Claude Code wipes `~/.claude/projects/<dir>/<uuid>.jsonl` after a few
  weeks via its `.last-cleanup` job. Older Claude sessions are only
  preserved in `~/.prosa/raw/sources/`.
- Codex preserves further back but old files migrate / get archived
  outside `~/.codex/sessions/` over time.
- Cursor's `~/.cursor/chats/` directory may be empty on a current install
  while the legacy bundle still has hundreds of `store.db` snapshots.
- Gemini's `~/.gemini/tmp/` keeps active session JSON but no long history.

If you ran prosa v2 against these tools before the v3 rewrite, the
bundle has everything.

## Bundle layout (v2)

```text
<bundle>/
  prosa.sqlite                # v2 SQLite catalog
  raw/
    sources/
      <blake3-hex>.zst        # one zstd-compressed verbatim copy
                              # of every original source file
  objects/                    # CAS for content blocks (ignored by v3)
  parquet/                    # analytics (ignored by v3)
  search/                     # tantivy index (ignored by v3)
  manifest.json
```

`prosa.sqlite` has a `source_files` table mapping
`(source_tool, path, size_bytes, mtime, content_hash)` to an
`object_id` of the form `blake3:<hex>`. The bundle stores the actual
file body as `raw/sources/<hex>.zst` — the importer reads from there
directly, not from `objects/`.

## What gets re-ingested

The catalog query is:

```sql
SELECT source_tool, path, substr(object_id, 8) AS oid_hex, size_bytes
FROM source_files
WHERE source_tool IN ('claude','codex','cursor','gemini')
  AND object_id LIKE 'blake3:%'
```

Each row's `.zst` is decompressed into a per-run temp directory; the
basename is preserved (e.g. `<oid-prefix>-<uuid>.jsonl`,
`<oid-prefix>-store.db`) so each v3 importer's filename-fallback
behavior continues to work. The standard per-importer
`Import(path, sink)` pipeline runs against that temp file — hash, peek
session id, idempotency check, parse, raw preservation under
`$PROSA_HOME/raw/<agent>/YYYY/MM/<sid>.<ext>`, then sink writes.

The bundle is **never modified**: the SQLite catalog opens read-only
(`mode=ro&immutable=1`) and the `.zst` files are only read.

## What does not get re-ingested

- `hermes` (had zero rows in practice; not in the IN-list).
- The v2 `content_blocks`, `messages`, `tool_calls`, `tool_results`,
  `events`, `edges`, and `search_docs` tables. v3 builds its own
  normalized data from the raw source files.
- `objects/` CAS blocks (intermediate chunks; not needed when full raw
  sources survive).

## Usage

```bash
# One-shot rescue ingest. Idempotent: re-running skips everything.
prosa sync --legacy-bundle ~/.prosa

# Verify months you expect to see.
sqlite3 "$XDG_DATA_HOME/prosa/store.db" "
  SELECT substr(started_at,1,7), agent, COUNT(*)
  FROM sessions GROUP BY 1, 2 ORDER BY 1, 2
"

# Once happy, the bundle is no longer load-bearing.
rm -rf ~/.prosa
```

The sync banner reminds you of the bundle path at the end of a
successful legacy run. It does not auto-delete anything — that
remains an explicit user action.

## Limits

- `~/.gemini/tmp/<projectHash>/logs.json` (the newer live shape) may
  carry multiple `sessionId`s in one file. Both the live walk and the
  bundle ingest project only the dominant (largest) session per file
  in this cut; smaller sessions would need a future multi-session walk.
- Cursor's `store.db` blobs do not carry per-message timestamps;
  `StartedAt == LastActivityAt == meta.createdAt`.
- v2 `is_subagent`, `parent_session_id`, and project-graph metadata are
  not projected; the v3 schema doesn't model them yet.
