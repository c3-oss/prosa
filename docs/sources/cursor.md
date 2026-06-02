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

- `<workspace-id>` is **`md5(workspace_absolute_path)`** in lowercase
  hex — `md5("/Users/foo/Projects/bar")` produces the directory name.
  This inverts cleanly: scan blobs for any absolute path the model
  touched, walk its ancestors, MD5 each, and the match is the
  workspace root. The importer uses this to recover `ProjectPath`.
- `<agent-id>` is a UUID and matches `meta.agentId`.
- `store.db-wal` / `store.db-shm` are SQLite's write-ahead log auxiliaries.
  The v3 importer only walks `store.db` and only copies that file into the
  prosa raw tree; the siblings are left in place.

## Identity

| Field | Source |
|---|---|
| Workspace path | md5-inverse of `<workspace-id>`; see _Workspace path resolution_ below |
| Agent / session | `<agent-id>` directory and `meta.agentId` |
| Last model | `meta.lastUsedModel` (when present) |
| Created at | `meta.createdAt` (Unix milliseconds, UTC after parse) |
| Last activity | max millisecond-epoch varint scanned out of protobuf state-node blobs |

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

### Timeline and timestamps

**The on-disk order of `blobs.id` is not chronological.** Faithful
ordering depends on the protobuf root state pointed to by
`meta.latestRootBlobId` (a SHA-256 chain of `0A 20 <32-byte-id>`
references). The v3 importer does not walk that DAG yet.

JSON message blobs (`role`/`content`/`id`/`providerOptions`) **do not
carry per-message timestamps** — community parsers confirm this is by
design. The v3 importer assigns every turn the session's
`StartedAt`.

The protobuf state-node blobs **do** embed millisecond Unix
timestamps as varints — the `0A 20` event-node family stores the event
time at field 26, and the todo-item families (`0A 0A`, `0A 15`) store
created/updated at fields 4 and 5. The importer sweeps every protobuf
blob for any varint in the unix-ms range (1.5e12–2.5e12) and uses the
max as `Session.LastActivityAt`. Per-turn timestamps stay at
`StartedAt`; only the session-level activity window advances.

### Workspace path resolution

`Session.ProjectPath` is resolved in three tiers, highest confidence
first:

1. **`meta.currentPlanUri`** — when present, a
   `file:///<workspace-root>/.cursor/plan-<uuid>.md` URI whose prefix
   is the workspace root.
2. **MD5 inversion** of the `<workspace-id>` directory segment. The
   importer scans every protobuf blob for printable absolute-path
   string fields, walks each path's ancestor directories, and returns
   the longest ancestor whose md5 equals the directory hash. Verified
   against real `.db` files on disk for two distinct workspaces.
3. **`<user_info>` blob fallback** — Cursor injects a system "user"
   blob at session start whose body contains
   `Workspace Path: /abs/path`. The importer parses that as a last
   resort.

### User prompts vs system wrappers

Cursor wraps human-authored prompts in `<user_query>` tags:

```
<timestamp>…</timestamp>
<user_query>
The actual user prompt text goes here.
</user_query>
```

It also injects several system blobs that arrive with `role:"user"`
but are NOT human-authored: `<user_info>` (env context),
`<system_reminder>` (system rules), `<attached_files>` (selected
code). The importer extracts the inner text of `<user_query>` when
present and skips blobs that begin with a known system wrapper tag —
otherwise `FirstPrompt` would lock onto the environment dump instead
of the real prompt.

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
- JSON message blobs carry no per-message timestamp; every
  `session.Turn.Timestamp` inherits `meta.createdAt`. The
  session-level `LastActivityAt` advances from the max ms-epoch
  varint scanned out of protobuf state-node blobs, so active-session
  detection (`LastActivityAt > now-10m`) is meaningful for cursor.
- Subagents/sub-sessions are not modeled with a clear causal link in
  Cursor's format. The importer does not synthesize parent/child
  edges. (`gemini_coder.Step.subtrajectory` in antigravity has no
  cursor analogue.)
- `Session.ProjectPath` is recovered locally from the `<workspace-id>`
  md5 inverse — sessions imported from another machine still land
  with the original workspace path string, even when that path
  doesn't exist on the importing host. `projectid.Apply` resolves the
  git remote when the path exists locally; otherwise `ProjectRemote`
  and `ProjectMarker` stay nil.

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

## References

The schema is closed-source and undocumented by Anysphere. Independent
community parsers converge on the layout above:

- [marcus/sidecar](https://github.com/marcus/sidecar/blob/main/docs/deprecated/guides/cursor-db-format-guide.md) — fullest single-file spec.
- [tyql688/cc-session](https://github.com/tyql688/cc-session/blob/main/CLAUDE.md) — Rust impl, the only public source documenting all three cursor session kinds (CLI / IDE Composer / ACP).
- [Alakazam-211/K2SO](https://github.com/Alakazam-211/K2SO/blob/main/docs/cursor-chat-migration.md) — distinguishes IDE Composer (`workspaceStorage/<hash>/state.vscdb`) from CLI Agent (`~/.cursor/chats/<md5>/<uuid>/store.db`).
- [OpenLAIR/dr-claw](https://github.com/OpenLAIR/dr-claw/blob/main/server/routes/cursor.js) — JS impl with the explicit `0x7B` JSON / `0x0A 0x20` protobuf classification.
- [specstoryai/getspecstory](https://github.com/specstoryai/getspecstory/blob/main/specstory-cli/pkg/providers/cursorcli/sqlite_reader.go) — production Go reader, proves the `?mode=ro&immutable=1` DSN coexists with a running cursor.
- [jxtngx/dgx-lab](https://github.com/jxtngx/dgx-lab/blob/main/backend/app/cursor_chats.py) — `currentPlanUri` → workspace path extraction.
