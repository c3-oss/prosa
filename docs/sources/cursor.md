# Cursor source format

Cursor stores agent sessions as SQLite databases under `~/.cursor/chats/`.
Each `store.db` is a tiny content-addressed object store with a small
`meta` table for session metadata and a `blobs` table for everything else
(JSON messages, plain text fragments, and binary/protobuf state).

Imported by `packages/prosa-core/src/importers/cursor/`.

## Layout

```text
~/.cursor/chats/
  <workspace-id>/
    <agent-id>/
      store.db
      store.db-wal
      store.db-shm
```

- `<workspace-id>` is an opaque Cursor workspace identifier (not a path).
- `<agent-id>` is a UUID and matches `meta.agentId`.
- `store.db-wal` / `store.db-shm` are SQLite's write-ahead log auxiliaries.
  Treat the trio as a unit when copying for forensic inspection.

## Identity

| Field | Source |
|---|---|
| Workspace | `<workspace-id>` directory name (opaque, no reverse mapping) |
| Agent / session | `<agent-id>` directory and `meta.agentId` |
| Latest root state | `meta.latestRootBlobId` → row in `blobs` |
| Last model | `meta.lastUsedModel` (when present) |

## Schema

Each `store.db` has the same two tables:

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
```

### `meta`

`meta` always has exactly one row with `key='0'` and a `value` that is
**JSON encoded as hexadecimal text**. Decode with
`xxd -r -p | jq .`. The decoded JSON is the session header:

```json
{
  "agentId": "…",
  "latestRootBlobId": "…",
  "name": "…",
  "mode": "default" | "auto-run" | "plan" | "search",
  "createdAt": <unix-ms>,
  "lastUsedModel": "…",      // optional
  "isRunEverything": …,       // optional
  "currentPlanUri": "…"       // optional
}
```

### `blobs`

`id` is a 64-char hex string (consistent with SHA-256 over `data`, but
not formally verified). `data` is one of:

- **JSON object** — first byte `7B` (`{`). Often a chat message with a
  `role` field.
- **JSON array** — first byte `5B` (`[`). Rare in observed corpora.
- **Plain text** — printable bytes; Markdown, diffs, code, paths, logs.
- **Protobuf-ish binary** — leading bytes `0A`, `12`, `1A` are common
  protobuf length-delimited tags. The session's root state is encoded
  this way and is the only place ordering between messages is recorded.

Counts (rough orders of magnitude in real workspaces): roughly 70 % of
blobs are protobuf-ish state, 25 % JSON, 5 % plain text. JSON-prefix
does not guarantee valid JSON.

### Chat messages

Valid JSON objects in `blobs` with a `role` field are messages.
Common roles: `tool`, `assistant`, `user`, `system`. Top-level fields:

```text
role, content, id, providerOptions
```

`content` may be a string or an array of parts. Tool calls and results
match on `toolCallId` inside content arrays.

### Timeline

**The on-disk order of `blobs.id` is not chronological.** Faithful
ordering depends on protobuf root state pointed to by
`meta.latestRootBlobId`. Without decoding that protobuf, any reconstructed
session ordering is an inference, not a fact — `prosa` projects Cursor
sessions with `timeline_confidence='low'` until decoding improves.

## Reading recipes

```bash
db="$HOME/.cursor/chats/<workspace-id>/<agent-id>/store.db"
# Always read read-only and immutable to coexist with a running Cursor:
ro="file:$db?mode=ro&immutable=1"
```

**Schema and counts:**

```bash
sqlite3 "$ro" ".schema"
sqlite3 "$ro" "SELECT 'meta', count(*) FROM meta UNION ALL SELECT 'blobs', count(*) FROM blobs;"
```

**Decode session metadata:**

```bash
sqlite3 "$ro" "SELECT value FROM meta WHERE key='0';" | xxd -r -p | jq .
```

**Classify blobs by leading byte:**

```bash
sqlite3 "$ro" "
  SELECT
    CASE
      WHEN length(data)=0 THEN 'empty'
      WHEN hex(substr(data,1,1))='7B' THEN 'json-object'
      WHEN hex(substr(data,1,1))='5B' THEN 'json-array'
      WHEN hex(substr(data,1,1)) IN ('0A','12','1A') THEN 'protobuf-ish'
      WHEN hex(substr(data,1,1)) BETWEEN '20' AND '7E' THEN 'plain-text'
      ELSE 'binary-' || hex(substr(data,1,1))
    END,
    count(*), sum(length(data))
  FROM blobs GROUP BY 1 ORDER BY 2 DESC;"
```

**Extract every JSON-object blob:**

```bash
sqlite3 "$ro" "
  SELECT id, length(data), CAST(data AS TEXT)
  FROM blobs
  WHERE hex(substr(data,1,1))='7B'
    AND json_valid(CAST(data AS TEXT));"
```

**Count messages by role across all databases:**

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" "
    SELECT coalesce(json_extract(CAST(data AS TEXT),'\$.role'),'__no_role__'),
           count(*)
    FROM blobs
    WHERE hex(substr(data,1,1))='7B' AND json_valid(CAST(data AS TEXT))
    GROUP BY 1;" 2>/dev/null
done | awk -F'|' '{c[$1]+=$2} END{for(k in c) print c[k], k}' | sort -nr
```

**Extract plain-text blobs (diffs, code fragments, etc.):**

```bash
sqlite3 "$ro" "
  SELECT id, length(data), substr(CAST(data AS TEXT), 1, 200)
  FROM blobs
  WHERE hex(substr(data,1,1)) BETWEEN '20' AND '7E'
  ORDER BY length(data) DESC;"
```

**Find sessions touching a path (text search across all databases):**

```bash
needle="src/foo.ts"
find ~/.cursor/chats -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" "
    SELECT '$db', count(*) FROM blobs
    WHERE CAST(data AS TEXT) LIKE '%$needle%';" 2>/dev/null |
    awk -F'|' '$2 > 0'
done
```

**Verify path-derived `agent_id` matches `meta.agentId`:**

```bash
agent_dir="$(basename "$(dirname "$db")")"
meta_agent="$(sqlite3 "$ro" "SELECT value FROM meta WHERE key='0';" \
  | xxd -r -p | jq -r '.agentId')"
[ "$agent_dir" = "$meta_agent" ] && echo match || echo mismatch
```

## Notes for prosa importers

- Always open with `mode=ro&immutable=1`. Do not lock or modify a
  database that Cursor may be writing.
- `meta.value` decodes from hex to UTF-8 JSON. The importer in
  `packages/prosa-core/src/importers/cursor/index.ts` runs this decode and projects the
  fields into `sessions` and `projects`.
- Blob classification (JSON / text / protobuf-ish / empty) drives
  whether a blob becomes a `messages` row, an `artifacts` row, or just
  a `raw_records` entry with no projection.
- For Cursor, `decoded_json_object_id` on `raw_records` is **populated**
  (not `NULL`) because the importer reads decoded JSON back during the
  same pass — see [Import pipeline](../architecture/import-pipeline.md).
- Without protobuf root-state decoding, **do not invent message
  ordering**. Project sessions with `timeline_confidence='low'` and
  record an `uncertainties` row when ordering depended on inference.
- Subagents/sub-sessions are not modeled with a clear causal link in
  Cursor's format. Do not synthesize edges from path or timestamp;
  leave the relationship `null` until evidence appears.
- The `id` of a blob is consistent with SHA-256 of its bytes, but the
  importer does not rely on this — every imported blob is restored to
  the prosa CAS under its own BLAKE3 hash.
- WAL/SHM files matter for forensics. To capture a complete snapshot
  (e.g. into `raw/sources/`), copy `store.db`, `store.db-wal`, and
  `store.db-shm` together, ideally after Cursor exits.

## Transcript fidelity

What `loadTranscript` / `prosa session show` surface for Cursor sessions:

- **Preserved verbatim**: text-content blocks of `user`, `assistant`,
  and `tool` messages, `tool-call.args` (raw JSON), and the
  `tool-result.result` payload — each lands as its own
  `content_blocks` row or as a `tool_call` / `tool_result` pair joined
  by `toolCallId`.
- **CAS (`text_object_id` / `*_object_id`)**: tool outputs go through
  `stageText`; `tool_results.output_object_id` carries the full body
  and the original blob is also preserved under `raw_records`. Long
  text content uses `content_blocks.text_object_id` when over the
  inline budget.
- **Hidden by default**: thinking/reasoning content blobs (when
  recognized) are projected as `block_type='thinking'` with
  `visibility='hidden_by_default'`; these are excluded from the
  default search index.
- **Summarized vs verbatim**: tool results carry a `preview` plus the
  matching `*_object_id` for the verbatim payload.
- **Gaps**: Cursor's protobuf root-state blob is **not** decoded —
  message ordering is best-effort from blob discovery order. Affected
  sessions land with `timeline_confidence='low'` and an
  `uncertainties` row. Subagent/sub-session causality is left `null`
  until a real signal appears in the source.
