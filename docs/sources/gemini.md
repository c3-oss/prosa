# Gemini CLI source format

Gemini CLI stores chats and logs as plain JSON (not JSONL) under
`~/.gemini/tmp/`. Two filename shapes carry session data: the legacy
bundle (`chats/session-*.json`, one envelope object per file) and the
newer live layout (`logs.json`, an array of standalone records).

Imported by `internal/importers/gemini/`.

## Layout

```text
~/.gemini/tmp/
  <project-hash-or-slug>/
    .project_root           # optional; absolute project path
    logs.json               # array of records (live layout)
    chats/
      session-<YYYY-MM-DD>T<HH-MM>-<session-prefix>.json
  bin/
    rg                      # bundled ripgrep, not session data
```

Two flavors of project directory:

- **Hash directory** (`<64-hex>`): the directory name equals the chat's
  `projectHash`. No `.project_root`.
- **Named directory** (slug like `mz-iac`, `sk-js`): contains
  `.project_root` with the absolute project path. `projectHash` inside
  the chats is still a hash, not the slug.

`bin/rg` is the bundled ripgrep binary; the v3 walker filters by
filename and never opens it.

## Identity

| Field | Source |
|---|---|
| Logical session id | `.sessionId` (envelope) or first row's `sessionId` (live array) |
| Project (real path) | `.project_root` when present, else the directory name |
| Project (internal id) | `.projectHash` (envelope only) |
| Snapshot file | `chats/session-<date>T<time>-<short-id>.json` or `logs.json` |

The 8-char suffix in the `session-*.json` filename matches the first
8 chars of `.sessionId`. The same `sessionId` may appear in multiple
files; the v3 importer treats each file as one independent unit keyed
on its sha256 (see Notes).

## Chat file shape (envelope)

```json
{
  "sessionId": "<uuid>",
  "projectHash": "<hash>",
  "startTime": "<ISO>",
  "lastUpdated": "<ISO>",
  "messages": [ /* … */ ],
  "kind": "…",       // optional
  "summary": "…"     // optional
}
```

### `messages[]`

Each entry has `type`, `timestamp`, `id`, `content`. `gemini` entries
also carry `model`, `thoughts`, `tokens`, `toolCalls`. `user` entries
may carry `displayContent`. `info` and `error` entries are smaller
operational records.

`type` values and how the v3 importer maps them:

| `type` | Mapped role | Notes |
|---|---|---|
| `user` | `user` | First non-empty text becomes `FirstPrompt` |
| `gemini` | `assistant` | First non-empty `model` becomes `session.Model` |
| `info` | (skipped) | No turn, no tool count |
| `error` | (skipped) | No turn, no tool count |

`content` may be a string or an array of objects with a `text` field.
The importer joins every non-empty `text` value with `\n`.

`tokens` (gemini only) is `{ cached, input, output, thoughts, tool, total }`.
The v3 importer does not project tokens today.

`thoughts` (gemini only) is an array of
`{ description, subject, timestamp }`. The v3 importer does not
project thoughts today.

### `messages[].toolCalls[]`

Gemini messages may include zero or more tool calls. Per-call fields
in the source JSON:

```text
id, name, displayName, description, args, result, resultDisplay,
status, timestamp, renderOutputAsMarkdown
```

The v3 importer reads only `name`, aggregating into `session.ToolUsage`
as `name → count`.

Common tool names observed in the corpus:

```text
replace, read_file, run_shell_command, write_file, list_directory,
google_web_search, write_todos, read_many_files, search_file_content,
glob, codebase_investigator, grep_search, browser_navigate, ask_user
```

Status values: `success`, `error`, `cancelled`.

`args` is an object keyed by tool. `result` is an array of items, each
either `text` or `functionResponse`. `functionResponse.response`
typically has `output` and/or `error`.

`resultDisplay` is the user-facing rendering. For file edits it can be
an object with `fileName`, `filePath`, `fileDiff`, `diffStat`,
`originalContent`, `newContent`, `isNewFile` — these may hold whole
files. The v3 cut does not project them.

## `logs.json` (live array)

A top-level JSON **array** (not an object). Each row:

```json
{
  "sessionId": "<uuid>",
  "messageId": 0,
  "type": "user" | "gemini" | "info" | "error",
  "timestamp": "<ISO>",
  "message": "<plain text>",
  "content": "…",       // optional; same shape as envelope
  "model": "…",         // optional, gemini-side only
  "toolCalls": [ /* … */ ]  // optional
}
```

A single `logs.json` may interleave records for **multiple
`sessionId` values**. The v3 importer projects only the **dominant
session** — the `sessionId` with the most rows in the file. Stray
rows for any other `sessionId` are dropped from the projection.

`logs.json` may also contain `sessionId` values for which **no
matching `session-*.json` exists** (older sessions where the chat was
rotated out). For those sessions, the importer treats `logs.json` as
the authoritative source.

In live-array rows, `message` is the canonical text body; if absent
the importer falls back to extracting text from `content`.

## `.project_root`

A single-line file inside `~/.gemini/tmp/<dir>/` containing an
absolute path. **Observed but not consumed** by the v3 importer:
project identity is derived from the cwd at sync time via
`internal/projectid`, the same idiom Cursor uses. A future cut may
read `.project_root` to recover Gemini sessions imported from another
machine; for now, sessions land without a project unless the cwd
resolves.

## Reading recipes

```bash
f="$HOME/.gemini/tmp/<dir>/chats/session-<…>.json"
```

**Map directories to real project paths:**

```bash
find ~/.gemini/tmp -name .project_root -print0 |
while IFS= read -r -d '' p; do
  printf '%s\t%s\n' "$(basename "$(dirname "$p")")" "$(tr -d '\n' < "$p")"
done | sort
```

**Validate every chat is valid JSON:**

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 -I{} sh -c 'jq empty "{}" >/dev/null 2>&1 || echo "invalid: {}"'
```

**Conversation as TSV (timestamp, type, text):**

```bash
jq -r '
  def t($c):
    if ($c|type) == "array" then [$c[]?.text? // empty] | join("\n")
    elif ($c|type) == "string" then $c else "" end;
  .messages[]? | select(.type=="user" or .type=="gemini") |
  [.timestamp, .type, t(.content)] | @tsv' "$f"
```

**All shell commands run, across all chats:**

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? | select(.toolCalls|type=="array") |
    .toolCalls[]? | select(.name=="run_shell_command") |
    [input_filename, .timestamp, (.status // ""),
     (.args.dir_path // .args.directory // ""),
     (.args.command // "")] | @tsv'
```

**Files touched (`replace` and `write_file`):**

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? | select(.toolCalls|type=="array") |
    .toolCalls[]? | select(.name=="replace" or .name=="write_file") |
    [input_filename, .timestamp, .name, (.status // ""),
     (.args.file_path // "")] | @tsv'
```

**Tool failures with their error text:**

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? | .toolCalls[]? | select(.status=="error") |
    [input_filename, .timestamp, .name,
     (.args.file_path // .args.dir_path // .args.directory // ""),
     ([.result[]?.functionResponse?.response?.error? // empty] | join("\n")
        | gsub("\n"; " ") | .[0:240])] | @tsv'
```

**Detect duplicate `sessionId` across files:**

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '.sessionId' | sort | uniq -c | awk '$1>1'
```

**Search chats for a term:**

```bash
q="search term"
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r --arg q "$q" '
    def t($c): if ($c|type)=="array" then [$c[]?.text? // empty] | join("\n") else ($c // "") end;
    .messages[]? |
    {file:input_filename, ts:.timestamp, type:.type, text:t(.content)} |
    select(.text | test($q; "i")) |
    [.ts, .type, .file, (.text | gsub("\n"; " ") | .[0:240])] | @tsv'
```

**Sum tokens per model (raw JSON, not projected by v3):**

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? | select(.type=="gemini" and (.tokens|type)=="object") |
    [(.model // "?"), (.tokens.input // 0), (.tokens.output // 0),
     (.tokens.total // 0)] | @tsv' |
  awk -F'\t' '{i[$1]+=$2; o[$1]+=$3; t[$1]+=$4}
              END {for (m in t) printf "%s\t%d\t%d\t%d\n", m, i[m], o[m], t[m]}'
```

**Render a session as Markdown:**

```bash
jq -r '
  def t($c): if ($c|type)=="array" then [$c[]?.text? // empty] | join("\n") else ($c // "") end;
  .messages[]? | select(.type=="user" or .type=="gemini" or .type=="info" or .type=="error") |
  "## " + (.type|ascii_upcase) + "\n\n" + t(.content) + "\n"' "$f"
```

**Dominant-session breakdown for a `logs.json`:**

```bash
jq -r '
  group_by(.sessionId) |
  map({sessionId: .[0].sessionId, rows: length}) |
  sort_by(-.rows) | .[] | [.rows, .sessionId] | @tsv' ~/.gemini/tmp/<dir>/logs.json
```

## Notes for prosa importers

- The importer walks **two filename patterns** under the root (default
  `~/.gemini/tmp/`): `chats/session-*.json` (envelope, one session per
  file) and `logs.json` (live array). The same code path also services
  legacy bundle re-ingests.
- Envelope shape: `{sessionId, projectHash, startTime, lastUpdated,
  messages: [...]}`. The session id is `sessionId`.
- Live-array shape: a JSON array of records, each with `sessionId`,
  `messageId`, `type`, `timestamp`, `message`, optional `content`,
  `model`, `toolCalls`.
- When a single `logs.json` carries records for multiple `sessionId`s,
  only the **dominant session** (the one with the most rows) is
  projected. Stray rows for other session ids in the same file are
  dropped silently.
- Role mapping: `type=="user"` → `user`, `type=="gemini"` →
  `assistant`. `info` and `error` are skipped entirely (no turn, no
  tool count).
- Tool aggregation: `messages[].toolCalls[].name` is counted per name
  to fill `session.ToolUsage`. Only the envelope path produces tool
  counts; the live-array projection ignores tool calls today.
- `FirstPrompt`: first user-side text, whitespace-collapsed (joined
  with single spaces) and truncated to ≤200 runes with a trailing
  `…`.
- `Model`: in the envelope path, the first assistant message's
  `model`. In the live-array path, the first assistant-side `model`
  encountered.
- Timestamps: parsed as RFC3339Nano then RFC3339; both stored UTC.
  `StartedAt` is the first timestamp seen, `LastActivityAt` is the
  latest.
- Raw preservation: the source JSON is copied byte-for-byte to
  `$PROSA_HOME/raw/gemini/<YYYY>/<MM>/<session-id>.json`. Atomic
  write-tmp + rename; the source is never modified.
- Project identity (`ProjectPath`, `ProjectRemote`, `ProjectMarker`)
  comes from `internal/projectid` against the cwd at sync time — the
  same idiom Cursor uses. Gemini itself does not record a cwd in any
  consumed field.
- Idempotency: keyed on `sha256(source file)` per session id.
  Re-importing a file whose hash matches the last recorded hash for
  the same session id is a no-op.
- `.project_root` files inside the `~/.gemini/tmp/<dir>/` directories
  are observed but **not consumed** by the v3 importer today. A
  future cut may use them to project cwd directly.
- `logs.json` may contain `sessionId` values for which no matching
  `session-*.json` exists (rotated-out chats). The importer treats
  `logs.json` as authoritative for those sessions.
- `codebase_investigator` is a tool, not a subagent. Cursor and
  Claude Code have explicit subagent layouts; Gemini does not. The
  importer does not synthesize parent/child session relationships.

## Transcript fidelity

What `session.Turn` and `session.ToolUsage` surface for Gemini
sessions today:

- **`session.Turn`**: one entry per `user` or `gemini` message with
  non-empty extracted text. `info` and `error` messages produce
  neither turns nor tool counts. The role is `"user"` for `user`
  messages and `"assistant"` for `gemini` messages.
- **`session.ToolUsage`**: name → count over every
  `messages[].toolCalls[].name` in the envelope path. The live-array
  path returns an empty tool list at this cut, since `logs.json` rows
  rarely populate `toolCalls`.
- **`session.Session.FirstPrompt`**: the first `user`-side text,
  whitespace-collapsed and truncated to ≤200 runes.
- **`session.Session.Model`**: the first `model` value seen on a
  `gemini` message (envelope) or assistant-side row (live).
- **`session.Session.StartedAt` / `LastActivityAt`**: min/max of the
  parsed timestamps across the projected rows. In the envelope path
  `startTime`/`lastUpdated` seed these before message scanning.
- **Preserved in raw**: the entire source JSON is copied unmodified
  into `$PROSA_HOME/raw/gemini/<YYYY>/<MM>/<session-id>.json`.
  `thoughts`, `tokens`, `resultDisplay` (with diffs and whole-file
  bodies), tool `args` / `result` payloads, `displayContent`,
  `kind`, `summary`, and every stray-session row from a multi-session
  `logs.json` remain reachable for future cuts.
- **Gaps**: each file is its own one-session-per-file unit keyed by
  `sha256`. There is no snapshot-merge contract — two different files
  carrying the same `sessionId` (e.g., a `session-*.json` and a
  `logs.json` projecting onto it) will each upsert independently, and
  the last write wins for `session.Session` fields while
  `RecordSync` rewrites the recorded hash. For `logs.json` files
  whose dominant session changes between syncs (rows added for a
  different `sessionId` that overtakes the previous winner), the
  importer will emit under the new dominant id and the previous one
  is not retroactively cleaned up — the raw on disk is the source
  of truth.
