# Gemini CLI source format

Gemini CLI stores chats and logs as plain JSON (not JSONL) under
`~/.gemini/tmp/`. Each chat file is a self-contained session snapshot.

Imported by `packages/prosa-core/src/importers/gemini/`.

## Layout

```text
~/.gemini/tmp/
  <project-hash-or-slug>/
    .project_root           # optional; absolute project path
    logs.json               # array of user input events
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

## Identity

| Field | Source |
|---|---|
| Logical session id | `.sessionId` inside the chat file |
| Project (real path) | `.project_root` when present, else the directory name |
| Project (internal id) | `.projectHash` |
| Snapshot file | `chats/session-<date>T<time>-<short-id>.json` |

The 8-char suffix in the filename matches the first 8 chars of
`.sessionId`. The same `sessionId` may appear in multiple files —
treat each file as a **snapshot**, group by `sessionId` for the logical
session.

## Chat file shape

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

Each message has `type`, `timestamp`, `id`, `content`. `gemini` messages
also carry `model`, `thoughts`, `tokens`, `toolCalls`. `user` messages
may carry `displayContent`. `info` and `error` messages are smaller
operational records.

`type` values:

```text
gemini  — model reply (the bulk of messages)
user    — user prompt
info    — operational info
error   — operational error
```

`content` may be a string or an array. Array form contains objects with a
`text` field.

`tokens` (gemini only) is `{ cached, input, output, thoughts, tool, total }`.

`thoughts` (gemini only) is an array of
`{ description, subject, timestamp }`.

### `messages[].toolCalls[]`

Gemini messages may include zero or more tool calls. Per-call fields:

```text
id, name, displayName, description, args, result, resultDisplay,
status, timestamp, renderOutputAsMarkdown
```

Common tool names:

```text
replace, read_file, run_shell_command, write_file, list_directory,
google_web_search, write_todos, read_many_files, search_file_content,
glob, codebase_investigator, grep_search, browser_navigate, ask_user
```

Status values: `success`, `error`, `cancelled`.

`args` is an object keyed by tool. `result` is an array of items, each
either `text` or `functionResponse`. `functionResponse.response` typically
has `output` and/or `error`.

`resultDisplay` is the user-facing rendering. For file edits it can be an
object with `fileName`, `filePath`, `fileDiff`, `diffStat`,
`originalContent`, `newContent`, `isNewFile` — these can hold whole files.

### `logs.json`

Array of `{ sessionId, messageId, type: "user", timestamp, message }`
entries. Captures user prompts only — no model replies — and may include
`sessionId` values that have **no matching chat file** (older sessions
where the chat was rotated out).

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

**Detect duplicate `sessionId` across files (snapshot vs. logical session):**

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

**Sum tokens per model:**

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

## Notes for prosa importers

- Treat each chat file as a **snapshot**, not a session of record.
  Duplicate `sessionId` across files becomes versions of one logical
  session, not separate sessions. See [Snapshot merge semantics](#snapshot-merge-semantics)
  below for the contract the prosa importer applies.
- For Gemini, `decoded_json_object_id` on `raw_records` is **populated**
  (not `NULL`) because the source is one big JSON file and per-message
  payloads are genuinely distinct objects worth caching — see
  [Import pipeline](../architecture/import-pipeline.md).
- `.project_root` is the only reliable way to map a project directory
  to a real path. Without it, the directory name should be treated as
  an opaque hash and `projectHash` carries the internal identity.
- `logs.json` is a useful auxiliary index but covers user prompts only.
  It can list `sessionId` values with no matching chat file. Project
  these as `events` with `event_type='user_prompt'` and a `confidence`
  reflecting the missing chat.
- `resultDisplay.newContent` and `originalContent` may hold whole files.
  Project them as `artifacts` (with `kind='file'` or `kind='diff'`) and
  reference the CAS object — do not inline.
- `thoughts[]` blocks are model reasoning. Project to `content_blocks`
  with `block_type='thinking'` and `visibility='hidden_by_default'` so
  Markdown export does not pollute the transcript.
- `codebase_investigator` is a tool, not a subagent. Cursor and Claude
  have explicit subagent files; Gemini does not. Do not synthesize
  parent/child session relationships.

### Snapshot merge semantics

When two or more chat files share the same `sessionId` the prosa Gemini
importer applies a **first-sorted-snapshot-wins** contract:

- Discovery is deterministic. `discoverGeminiChats` sorts project
  directories under the scan root and then `session-*.json` files inside
  each `chats/` directory with `localeCompare`. The first file in that
  order is the **canonical snapshot** for its `sessionId`.
- Every normalized write — `sessions`, `events`, `messages`,
  `content_blocks`, `tool_calls`, `tool_results`, `artifacts`,
  `search_docs` — uses `INSERT OR IGNORE`. Row ids are deterministic
  hashes that include the `sessionId` and the message/event ordinal
  (1-indexed by position in `messages[]`), so a later snapshot for the
  same session collides on the primary key and its rows are silently
  dropped at the row level.
- Concretely: if snapshot **A** has three messages and snapshot **B**
  (same `sessionId`, sorted later) has four messages with different
  content at the same ordinals, every row whose deterministic id
  matches an A-row is dropped. That catches the `sessions` row,
  A's overlapping `messages`, `events`, `content_blocks`, `tool_calls`,
  `tool_results`, `artifacts`, and `search_docs`. Rows in B whose
  natural key does **not** collide with A (e.g., a message at ordinal
  4 that A never produced, or a tool call with a Gemini-side id A did
  not see) still land — the importer does not enforce a stricter
  "drop everything from later snapshots" rule. This is partial-merge
  behavior: treat it as a side effect of the current row-level
  contract, not a guarantee.
- `raw_records` is the escape hatch. It also uses `INSERT OR IGNORE`,
  but its primary key is `(source_file_id, ordinal, raw_object_id)`, so
  the per-snapshot rows are distinct and **every snapshot's bytes are
  preserved** in CAS. A future merge strategy can replay them without
  reimporting.
- Whenever the importer notices a duplicate snapshot (the canonical
  `session_id` is already in the bundle when a later snapshot is being
  processed) it appends an `import_errors` row with
  `kind = 'gemini_duplicate_snapshot'` and a payload pointing at the
  dropped file path. The batch still completes successfully — the row
  is informational so operators can audit silent drops.
- To merge second-snapshot data, reimport into a fresh bundle. A proper
  merge strategy (last-write-wins, per-message versioning, etc.) is out
  of scope for the current importer; future work is tracked in
  [`../../ROADMAP.md`](../../ROADMAP.md).

## Transcript fidelity

What `loadTranscript` / `prosa v1 session show` surface for Gemini sessions:

- **Preserved verbatim**: user prompts and Gemini responses (each
  `messages[]` entry projects to a `content_blocks` row), tool-call
  `args`, and tool-result payloads. `info`/`error` entries land as
  operational events, not chat messages.
- **CAS (`text_object_id` / `*_object_id`)**: tool outputs are routed
  through `stageText`; oversize bodies live in
  `tool_results.output_object_id` and large file-read attachments use
  `content_blocks.text_object_id`. The whole original snapshot's bytes
  always live under `raw_records` as well.
- **Hidden by default**: reasoning content (when present in
  `messages[].thoughts`) is projected as
  `content_blocks.block_type='thinking'` with
  `visibility='hidden_by_default'`. The importer offsets thinking-block
  ordinals by `HIDDEN_BLOCK_ORDINAL_BASE` so they sort after the visible
  content of the same message.
- **Summarized vs verbatim**: `tool_results.preview` is a short copy of
  the rendered output; use the matching `*_object_id` for the verbatim
  body.
- **Gaps**: snapshots collide at the row level (`INSERT OR IGNORE` per
  message id), so a later snapshot of the same chat can be partially
  dropped — `import_errors` with `kind='gemini_duplicate_snapshot'`
  flags the case. Re-importing into a fresh bundle is the current
  recovery path.
