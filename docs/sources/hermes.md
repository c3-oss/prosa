# Hermes source format

Hermes stores agent sessions across two surfaces: a single SQLite database
(`~/.hermes/state.db`) that holds normalized sessions plus messages, and a
companion `sessions/` directory that may also carry the same sessions as
JSONL transcripts or JSON snapshots. The same logical `session_id` can
appear in either or both surfaces; when both surfaces describe the same
session, the one with more messages wins.

Imported by `internal/importers/hermes/`.

## Layout

```text
~/.hermes/
  state.db
  state.db-wal
  state.db-shm
  sessions/
    sessions.json
    <session-id>.jsonl
    session_<session-id>.json
    saved/
      ...
```

- `state.db` is the normalized store: one `sessions` row per logical
  session and many `messages` rows joined by `session_id`.
- `state.db-wal` / `state.db-shm` are SQLite's write-ahead-log auxiliaries
  and are not copied into the prosa raw tree — the `.db` alone is enough
  for the projection.
- `sessions/` is the legacy / fallback surface. Top-level `<id>.jsonl`
  transcripts and `session_<id>.json` snapshots are first-class inputs.
- `sessions/sessions.json` is an index file (observed but not consumed —
  see below).
- `sessions/saved/` and any other nested directory are ignored. The
  walker is non-recursive inside `sessions/`.

## Identity

| Field | Source |
|---|---|
| Logical session id | `sessions.id` (SQLite); `session_id` field (`session_*.json`); filename stem (`<id>.jsonl`) |
| Source / platform | `sessions.source` (SQLite); `platform` field (snapshots) |
| Model | `sessions.model` (SQLite); top-level `model` field (snapshots); falls back to per-message `model` |
| Start time | `sessions.started_at` (unix seconds); `session_start` (ISO 8601, snapshots); `min(timestamp)` over JSONL messages |
| End / last activity | `sessions.ended_at`; `last_updated` (snapshots); `max(timestamp)` over JSONL messages |
| Parent session | `sessions.parent_session_id` (SQLite only; not projected) |

Hermes does not record a cwd. `ProjectPath`, `ProjectRemote`, and
`ProjectMarker` come from `internal/projectid` against the cwd at sync
time — same idiom as Cursor and Gemini.

## SQLite schema

`state.db` exposes two tables that matter to the importer:

```sql
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  model             TEXT,
  model_config      TEXT,
  system_prompt     TEXT,
  parent_session_id TEXT,
  started_at        REAL NOT NULL,
  ended_at          REAL,
  end_reason        TEXT,
  message_count     INTEGER,
  tool_call_count   INTEGER,
  title             TEXT
);

CREATE TABLE messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL,
  role                  TEXT NOT NULL,
  content               TEXT,
  tool_call_id          TEXT,
  tool_calls            TEXT,
  tool_name             TEXT,
  timestamp             REAL NOT NULL,
  token_count           INTEGER,
  finish_reason         TEXT,
  reasoning             TEXT,
  reasoning_content     TEXT,
  reasoning_details     TEXT,
  codex_reasoning_items TEXT,
  codex_message_items   TEXT
);
```

Timestamps in SQLite are **unix seconds as `REAL`** (millisecond fractions
allowed). JSON snapshots emit timestamps as **ISO 8601 strings**. The
importer normalizes both to UTC `time.Time` after parse.

`messages.content`, `messages.tool_calls`, and the reasoning columns may
hold plain text or JSON-encoded values; the importer treats them as
opaque strings unless a column is explicitly parsed (`tool_calls`).

## Transcript files (`.jsonl`)

Top-level `<session-id>.jsonl` is one message object per line. The
session id is the filename stem (`abcd.jsonl` → `abcd`). Each line shares
the column shape of a `messages` row — `role`, `content`, optional
`tool_calls`, `timestamp`, and the same hidden reasoning fields.

The walker yields every top-level `.jsonl` under `sessions/` and ignores
any nested directories.

## JSON snapshots (`session_*.json`)

A snapshot is a single JSON object that mirrors one session end-to-end:

```json
{
  "session_id": "...",
  "session_start": "2026-05-15T00:40:00.000Z",
  "last_updated": "2026-05-15T00:41:00.000Z",
  "platform": "cli",
  "model": "...",
  "system_prompt": "...",
  "messages": []
}
```

The walker yields every top-level file whose name matches
`session_*.json`. Session id comes from the `session_id` field; if that
field is missing the importer falls back to the filename stem after the
`session_` prefix (`session_abcd.json` → `abcd`).

## `sessions.json` (index, not consumed)

`sessions/sessions.json` is Hermes' own session index — a flat array of
session metadata. The walker observes the file (so it shows up in
directory listings) but does **not** yield it: it carries no message
bodies and would only duplicate identity data already present in
`state.db` and the per-session transcripts. Future cuts may consume it
to repair sessions whose only signal is the index, but at this cut it
is intentionally skipped.

## Reading recipes

```bash
db="$HOME/.hermes/state.db"
sessions="$HOME/.hermes/sessions"
# Read SQLite read-only to coexist with a running Hermes:
ro="file:$db?mode=ro&immutable=1"
```

**Schema and counts:**

```bash
sqlite3 "$ro" ".schema sessions"
sqlite3 "$ro" ".schema messages"
sqlite3 "$ro" "
  SELECT 'sessions', count(*) FROM sessions
  UNION ALL
  SELECT 'messages', count(*) FROM messages;"
```

**List recent sessions:**

```bash
sqlite3 "$ro" "
  SELECT datetime(started_at, 'unixepoch'), source, model, message_count, title
  FROM sessions
  ORDER BY started_at DESC
  LIMIT 20;"
```

**Render a single session as a transcript:**

```bash
id="<session-id>"
sqlite3 "$ro" "
  SELECT datetime(timestamp,'unixepoch'), role, substr(content,1,200)
  FROM messages
  WHERE session_id='$id'
  ORDER BY timestamp ASC, id ASC;"
```

**Find transcript files with more messages than SQLite knows about:**

```bash
find "$sessions" -maxdepth 1 -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  id="$(basename "$f" .jsonl)"
  lines="$(grep -cve '^[[:space:]]*$' "$f")"
  db_count="$(sqlite3 "$ro" "SELECT coalesce(message_count, 0) FROM sessions WHERE id='$id';")"
  [ "${db_count:-0}" -lt "$lines" ] && printf '%s\tdb=%s\tjsonl=%s\n' "$id" "$db_count" "$lines"
done
```

**Same comparison for JSON snapshots:**

```bash
find "$sessions" -maxdepth 1 -name 'session_*.json' -print0 |
while IFS= read -r -d '' f; do
  id="$(jq -r '.session_id // empty' "$f")"
  [ -z "$id" ] && id="$(basename "$f" .json | sed 's/^session_//')"
  msgs="$(jq '.messages | length' "$f")"
  db_count="$(sqlite3 "$ro" "SELECT coalesce(message_count, 0) FROM sessions WHERE id='$id';")"
  [ "${db_count:-0}" -lt "$msgs" ] && printf '%s\tdb=%s\tjson=%s\n' "$id" "$db_count" "$msgs"
done
```

**Search every transcript file for a needle:**

```bash
needle="src/foo.ts"
find "$sessions" -maxdepth 1 \( -name '*.jsonl' -o -name 'session_*.json' \) -print0 |
xargs -0 grep -l -- "$needle"
```

**Tool-call counts across all SQLite sessions:**

```bash
sqlite3 "$ro" "
  SELECT json_extract(value,'\$.function.name'), count(*)
  FROM messages, json_each(messages.tool_calls)
  WHERE messages.tool_calls IS NOT NULL
    AND json_valid(messages.tool_calls)
  GROUP BY 1
  ORDER BY 2 DESC
  LIMIT 20;"
```

## Notes for prosa importers

- **Default root**: `~/.hermes/sessions`. The importer also looks one
  level up for the sibling `state.db`.
- **Walk** yields three flavors of file, non-recursively:
  - the sibling `state.db`, one path, only when it exists;
  - every top-level `*.jsonl` under the root;
  - every top-level `session_*.json` under the root.
  `sessions.json` is observed but not yielded. `saved/` and any other
  nested directory are intentionally skipped at this cut.
- **Session id resolution** per input flavor:
  - `<id>.jsonl` → filename stem.
  - `session_<id>.json` → the `session_id` JSON field; fall back to the
    filename stem after the `session_` prefix.
  - `state.db` → the `sessions.id` column. One `state.db` carries many
    sessions; the importer iterates `sessions` rows and runs the sink
    once per row.
- **Dual-source merge**: when the same logical `session_id` lives in
  both `state.db` and a sibling transcript file, the surface with the
  larger message count wins. The importer compares
  `sessions.message_count` against the line count of `<id>.jsonl` or
  the `messages` array length of `session_<id>.json`. If a transcript
  file has more messages, the SQLite row's projection is suppressed
  and the transcript file's projection runs instead. The dropped side
  is still copied into the prosa raw tree.
- **Hidden reasoning columns** — `messages.reasoning`,
  `messages.reasoning_content`, `messages.reasoning_details`,
  `messages.codex_reasoning_items`, and `messages.codex_message_items`
  are **not** projected into `session.Turn` at this cut (the canonical
  contract is text-only). They remain reachable in the preserved raw.
- **Tool usage** — `messages.tool_calls` is parsed as a JSON array of
  OpenAI-style objects. The `name` field of each entry fills
  `session.ToolUsage`. Empty / unparseable arrays contribute nothing.
- **Idempotency** is keyed on the source file's sha256, identical to
  every other v3 importer. Re-importing an unchanged file is a no-op.
  For `state.db`, the same file hash applies to every session row in
  the DB — any change to the database causes every session inside to
  re-parse and re-upsert. This is correct (the file content really did
  change) and only slightly wasteful (sessions are small).
- **Raw preservation** writes the source bytes to
  `$PROSA_HOME/raw/hermes/<YYYY>/<MM>/<session-id>.<ext>`, where
  `<ext>` is `db`, `jsonl`, or `json`. For `state.db`, every session
  id gets its own raw copy that points at the same underlying bytes
  (each named after its `sessions.id`).
- **Project identity** (`ProjectPath`, `ProjectRemote`,
  `ProjectMarker`) comes from `internal/projectid` against the cwd at
  sync time — Hermes itself does not record a cwd. Sessions imported
  from another machine land without a project until the same repo is
  cloned and re-resolved.
- **WAL / SHM** siblings of `state.db` are not copied into the raw
  tree. SQLite's own recovery path reads the canonical `.db`, and the
  prosa contract does not include recovery semantics.

## Transcript fidelity

What `session.Turn` and `session.ToolUsage` surface for Hermes today:

- **`session.Turn`**: one entry per `messages.role` of `user` or
  `assistant` (and the same role values in JSONL / JSON), in
  `timestamp ASC, id ASC` order. `Content` is `messages.content`
  verbatim. `tool`-role messages do not produce turns — they are
  tool-result echoes and are counted indirectly through the originating
  assistant turn's `tool_calls`.
- **`session.ToolUsage`**: name → count, summed over every entry in
  every `messages.tool_calls` array within the session (and the
  equivalent field in transcript files).
- **`session.Session.FirstPrompt`**: the first `user`-role
  `messages.content`, whitespace-collapsed and truncated to ≤200 runes.
- **`session.Session.Model`**: `sessions.model`, the snapshot's
  top-level `model`, or the first per-message `model` — first non-empty
  wins.
- **Preserved in raw** for future cuts:
  - the full `state.db` (or `.jsonl` / `.json` source file) byte for
    byte;
  - every hidden reasoning column (`messages.reasoning`,
    `reasoning_content`, `reasoning_details`,
    `codex_reasoning_items`, `codex_message_items`);
  - `sessions.system_prompt`, `model_config`, `end_reason`,
    `parent_session_id`, `title`, and per-message `token_count` /
    `finish_reason`;
  - the full body of every `tool_calls` payload and `tool` -role
    `content` blob, beyond what the `ToolUsage` aggregate counts.
- **Dual-source gap**: when both `state.db` and a transcript file
  describe the same session and one surface is dropped (because the
  other had more messages), the dropped side's source bytes are still
  copied to the raw tree but its rows do not appear in `turns`. A
  future cut can read the preserved raw to merge the two surfaces; the
  importer at this cut does not attempt the merge.
