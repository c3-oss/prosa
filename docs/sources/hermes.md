# Hermes source format

Hermes stores session metadata and messages in SQLite and may also keep
transcript files under `~/.hermes/sessions/`.

Imported by `packages/prosa-core/src/importers/hermes/`.

## Layout

```text
~/.hermes/
  state.db
  sessions/
    sessions.json
    <session-id>.jsonl
    session_<session-id>.json
    saved/
      ...
```

`prosa compile hermes` defaults to `~/.hermes/sessions`. The importer looks
for the sibling `state.db`, top-level `.jsonl` transcripts, top-level
`session_*.json` snapshots, and `sessions.json` as an index/source file.
Nested directories such as `saved/` are ignored for now.

## Identity

| Field | Source |
|---|---|
| Logical session id | `sessions.id`, `.session_id`, or the JSONL filename |
| Source/platform | `sessions.source` or JSON snapshot `platform` |
| Model | `sessions.model`, snapshot `model`, or message-level model |
| Start/end time | SQLite unix seconds or snapshot/message timestamps |

If SQLite and a transcript file describe the same session, the importer uses
the source with the larger message count. This matches Hermes' own recovery
behavior for legacy transcripts that are more complete than `state.db`.

## SQLite schema

Observed `state.db` tables include:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  model TEXT,
  model_config TEXT,
  system_prompt TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  end_reason TEXT,
  message_count INTEGER,
  tool_call_count INTEGER,
  title TEXT
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  token_count INTEGER,
  finish_reason TEXT,
  reasoning TEXT,
  reasoning_content TEXT,
  reasoning_details TEXT,
  codex_reasoning_items TEXT,
  codex_message_items TEXT
);
```

SQLite timestamps are unix seconds. `content`, `tool_calls`, and reasoning
columns may contain plain text or JSON-encoded values.

## Transcript files

JSONL transcripts are one message object per line. The session id is derived
from the filename without `.jsonl`.

JSON snapshots use a shape like:

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

## Importer notes

- Raw source bytes are preserved for SQLite, JSONL, JSON snapshot, and
  `sessions.json` files.
- Hidden reasoning fields are stored as `hidden_by_default` content blocks.
  They are not indexed for search and are omitted from Markdown exports.
- Tool calls are read from OpenAI-style `tool_calls` arrays and from Hermes
  tool result rows with `tool_call_id`.
- Top-level transcript files can repair sessions where SQLite has fewer
  messages.

## Reading recipes

```bash
db="$HOME/.hermes/state.db"
sessions="$HOME/.hermes/sessions"
```

**Count sessions and messages in SQLite:**

```bash
sqlite3 "$db" "
  SELECT 'sessions', count(*) FROM sessions
  UNION ALL
  SELECT 'messages', count(*) FROM messages;"
```

**List recent sessions:**

```bash
sqlite3 "$db" "
  SELECT datetime(started_at, 'unixepoch'), source, model, message_count, title
  FROM sessions
  ORDER BY started_at DESC
  LIMIT 20;"
```

**Find transcript files with more lines than SQLite message counts:**

```bash
find "$sessions" -maxdepth 1 -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  id="$(basename "$f" .jsonl)"
  lines="$(grep -cve '^[[:space:]]*$' "$f")"
  db_count="$(sqlite3 "$db" "SELECT coalesce(message_count, 0) FROM sessions WHERE id='$id';")"
  [ "${db_count:-0}" -lt "$lines" ] && printf '%s\t%s\t%s\n' "$id" "$db_count" "$lines"
done
```
