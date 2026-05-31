# Cursor source format

Cursor stores agent sessions as SQLite databases under `~/.cursor/chats/`.
Each `store.db` is a tiny content-addressed object store with a small
`meta` table for session metadata and a `blobs` table for everything else
(JSON messages, plain text fragments, and binary/protobuf state).

Imported by `internal/importers/cursor/`.

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
  The v3 importer only walks `store.db` and only copies that file into the
  prosa raw tree; the siblings are left in place.

## Identity

| Field | Source |
|---|---|
| Workspace | `<workspace-id>` directory name (opaque, no reverse mapping) |
| Agent / session | `<agent-id>` directory and `meta.agentId` |
| Last model | `meta.lastUsedModel` (when present) |
| Created at | `meta.createdAt` (Unix milliseconds, UTC after parse) |

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

A few legacy stores wrote `value` as plain JSON instead of hex. The v3
importer falls back to plain-JSON parsing when the hex decode fails.

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

Roughly 70 % of blobs are protobuf-ish state, 25 % JSON, 5 % plain text.
A JSON prefix does not guarantee valid JSON.

### Chat messages

Valid JSON objects in `blobs` with a `role` field are messages.
Common roles: `tool`, `assistant`, `user`, `system`. Top-level fields:

```text
role, content, id, providerOptions
```

`content` may be a string or an array of typed parts. Common content
item types: `text`, `tool-call`. The v3 importer keeps every `text`
item and counts every `tool-call`'s `toolName`.

### Timeline

**The on-disk order of `blobs.id` is not chronological.** Faithful
ordering depends on the protobuf root state pointed to by
`meta.latestRootBlobId`. The v3 importer does not decode that
protobuf today, so all turns share a single timestamp:
`meta.createdAt`. `LastActivityAt` mirrors `StartedAt` for the same
reason.

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

## Notes for prosa importers

- Opens SQLite with `mode=ro&immutable=1` (via `modernc.org/sqlite`).
  Never locks or modifies a database that Cursor may be writing.
- `meta.value` is decoded from hex to UTF-8 JSON. A legacy
  plain-JSON fallback exists for older stores.
- Only blob rows whose `data` starts with `{` or `[` and parses as
  JSON with a non-empty `role` field become turns. Everything else
  (protobuf state, plain text fragments, JSON without a role) is
  ignored at this cut.
- Tool usage is aggregated from `content[]` items whose `type ==
  "tool-call"` and which carry a non-empty `toolName`. Count is the
  number of such items per name within the session.
- **Token usage is not recoverable from `store.db`.** Cursor stores
  message bodies and tool calls but never per-message token counts. The
  parser therefore always reports `session.UsageStateUnknown`; the
  importer admits the session and stores it without a `session_usage`
  row. Cursor sessions appear in sessions/projects/heatmap/tools and
  the panel's `/analytics/usage` view filters them out via
  `session_usage IS NULL`, so they are intentionally absent from the
  cost panel.
- `WAL`/`SHM` siblings are not copied into the prosa raw tree —
  recovery semantics for `store.db` are not part of the prosa
  contract. The single `.db` is enough for the projection.
- Cursor does not record per-message timestamps. The v3 importer
  assigns `meta.createdAt` to every `session.Turn.Timestamp`, and
  the session's `StartedAt` and `LastActivityAt` are equal. This
  means active-session detection (`LastActivityAt > now-10m`) under
  the central question is best-effort for Cursor.
- Subagents/sub-sessions are not modeled with a clear causal link in
  Cursor's format. The importer does not synthesize parent/child
  edges.
- Project identity (`ProjectPath`, `ProjectRemote`, `ProjectMarker`)
  comes from `internal/projectid` against the cwd at sync time —
  Cursor itself does not record a cwd. Sessions imported from
  another machine will land without a project until the same repo
  is cloned and re-resolved.

## Transcript fidelity

What `session.Turn` and `session.ToolUsage` surface for Cursor:

- **`session.Turn`**: one entry per `user` or `assistant` role with
  non-empty joined text content (`content[].text`). `tool`-role
  messages do not produce turns (their text is tool-result echo).
- **`session.ToolUsage`**: name → count for every `tool-call` content
  item.
- **`session.Session.FirstPrompt`**: the first `user`-role text,
  whitespace-collapsed and truncated to ≤200 runes.
- **`session.Session.Model`**: `meta.lastUsedModel`, when present.
- **Preserved in raw**: the entire `store.db` is copied byte-for-byte
  into `$PROSA_HOME/raw/cursor/<YYYY>/<MM>/<session-id>.db`. The
  protobuf root state, all unprojected blobs, `meta` extras, and
  every plain-text/binary blob remain reachable for future cuts.
