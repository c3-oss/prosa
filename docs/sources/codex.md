# Codex CLI source format

Codex CLI stores session histories as append-only JSONL under
`~/.codex/sessions/`. This is the format `prosa compile codex` reads.

Imported by `packages/prosa-core/src/importers/codex/`.

## Layout

```text
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<local-date>T<local-time>-<session-id>.jsonl
```

- One file per session (or sub-session).
- The `YYYY/MM/DD` tree uses the machine's **local** date.
- Internal record timestamps are ISO UTC.
- The filename suffix is the `session-id` and matches
  `session_meta.payload.id` in recent files.
- The currently active session keeps appending to its file as the user
  works.

## Identity

| Field | Source | Notes |
|---|---|---|
| Session id | `session_meta.payload.id` (and filename suffix) | Older files may lack `session_meta` — fall back to filename |
| CWD / project | `session_meta.payload.cwd`, `turn_context.payload.cwd` | Per-turn cwd may shift |
| Subagent parent | `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` | Subagents are normal session files; relationship lives in metadata |
| Originator | `session_meta.payload.originator` | `codex_cli_rs`, `codex-tui`, `codex_exec`, … |

## Record format

Each line is one JSON object. Recent files use an envelope:

```json
{
  "type": "session_meta" | "turn_context" | "response_item" | "event_msg" | "compacted",
  "timestamp": "2026-05-03T21:27:41.778Z",
  "payload": { /* type-specific */ }
}
```

Older files may store top-level `message`, `reasoning`, `function_call`,
or `function_call_output` records without an envelope. The importer
handles both shapes.

### `session_meta`
Identity and start-of-session metadata: `id`, `timestamp`, `cwd`,
`cli_version`, `originator`, `model_provider`, optional `git`, optional
`source` (string for normal sessions, object for subagents).

### `turn_context`
One per turn. Holds the execution context for that turn:
`model`, `effort`, `approval_policy`, `sandbox_policy`,
`collaboration_mode`, `cwd`, `current_date`, `timezone`,
`user_instructions`, `summary` (when there's a compaction or resume),
`turn_id`.

### `response_item`
Transcript and model calls. `payload.type` discriminates:

| `payload.type` | Meaning | Important fields |
|---|---|---|
| `message` | User/assistant/developer text | `role`, `content[]` (`input_text`, `output_text`, `input_image`) |
| `function_call` | Tool call | `name`, `call_id`, `arguments` |
| `function_call_output` | Tool result | `call_id`, `output` |
| `reasoning` | Model reasoning (often opaque) | `summary`, `encrypted_content` |
| `custom_tool_call` / `custom_tool_call_output` | Provider-extended tools | `name`, `call_id` |
| `web_search_call` | Web search intent | `action` |
| `ghost_snapshot` | Snapshot marker | `ghost_commit` |

### `event_msg`
Operational UI/tool events. `payload.type` discriminates:

```text
token_count, agent_reasoning, exec_command_end, agent_message,
user_message, task_started, task_complete, patch_apply_end,
web_search_end, mcp_tool_call_end, turn_aborted, item_completed,
context_compacted, view_image_tool_call, error
```

`exec_command_end` is the audit-grade record of a shell command:
`call_id`, `command`, `cwd`, `exit_code`, `stdout`, `stderr`,
`formatted_output`, `aggregated_output`, `duration`, `status`.

### Tool call ↔ result matching

`call_id` ties everything together:

```text
response_item.function_call.call_id
response_item.function_call_output.call_id
event_msg.exec_command_end.call_id
event_msg.patch_apply_end.call_id
event_msg.mcp_tool_call_end.call_id
event_msg.web_search_end.call_id
```

## Reading recipes

Pick a session for the examples:

```bash
f="$HOME/.codex/sessions/2026/05/03/rollout-2026-05-03T18-27-41-<session-id>.jsonl"
```

**Keys at top level of each line:**

```bash
head -5 "$f" | jq -c 'keys'
```

**Session metadata:**

```bash
jq -c 'select(.type=="session_meta") |
  { id: .payload.id, created_utc: .payload.timestamp,
    cli_version: .payload.cli_version, cwd: .payload.cwd,
    originator: .payload.originator }' "$f"
```

**Conversation as TSV (timestamp, role, text), covering both the current
envelope and legacy records:**

```bash
jq -r '
  def t($c):
    if ($c|type)=="array" then [$c[]?.text? // empty] | join("\n")
    elif ($c|type)=="string" then $c else "" end;
  if .type=="response_item" and .payload.type=="message" then
    [.timestamp, .payload.role, t(.payload.content)] | @tsv
  elif .type=="message" then
    [.timestamp, .role, t(.content)] | @tsv
  elif .type=="event_msg" and (.payload.type=="user_message" or .payload.type=="agent_message") then
    [.timestamp, .payload.type, (.payload.message // "")] | @tsv
  else empty end' "$f"
```

**Shell commands run in a session:**

```bash
jq -r 'select(.type=="event_msg" and .payload.type=="exec_command_end") |
  [.timestamp, (.payload.exit_code|tostring), (.payload.cwd // ""),
   ((.payload.command // "") | if type=="string" then . else tojson end)] | @tsv' "$f"
```

**Failed commands across the entire corpus:**

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="event_msg" and .payload.type=="exec_command_end") |
    select((.payload.exit_code // 0) != 0) |
    [input_filename, .timestamp, (.payload.exit_code|tostring),
     (.payload.cwd // ""),
     ((.payload.command // "") | if type=="string" then . else tojson end)] | @tsv'
```

**Search messages only (skip operational noise):**

```bash
q="search term"
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r --arg q "$q" '
    def t($c): if ($c|type)=="array" then [$c[]?.text? // empty] | join("\n") else ($c // "") end;
    if .type=="response_item" and .payload.type=="message" then
      {file:input_filename, ts:.timestamp, role:.payload.role, text:t(.payload.content)}
    elif .type=="message" then
      {file:input_filename, ts:(.timestamp // ""), role:.role, text:t(.content)}
    elif .type=="event_msg" and (.payload.type=="user_message" or .payload.type=="agent_message") then
      {file:input_filename, ts:.timestamp, role:.payload.type, text:(.payload.message // "")}
    else empty end
    | select(.text | test($q; "i"))
    | [.ts, .role, .file, (.text | gsub("\n"; " ") | .[0:180])] | @tsv'
```

**Filter sessions by cwd:**

```bash
needle="/Users/you/Projects/project-name"
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -s -e --arg needle "$needle" '
    any(.[];
      (.type=="session_meta" and ((.payload.cwd // "") | contains($needle))) or
      (.type=="turn_context" and ((.payload.cwd // "") | contains($needle))))' "$f" >/dev/null 2>&1 \
    && printf '%s\n' "$f"
done
```

**Export one session to Markdown:**

```bash
jq -r '
  def t($c): if ($c|type)=="array" then [$c[]?.text? // empty] | join("\n") else ($c // "") end;
  if .type=="response_item" and .payload.type=="message" then
    {role:.payload.role, text:t(.payload.content)}
  elif .type=="message" then
    {role:.role, text:t(.content)}
  else empty end
  | select(.text != "")
  | "## " + (.role|ascii_upcase) + "\n\n" + .text + "\n"' "$f"
```

`prosa export session <session-id> --format markdown` does this with
metadata and tool-call summaries; the recipe above is for raw inspection.

## Notes for prosa importers

- Recent files use the envelope; older files may emit top-level
  `message`, `reasoning`, `function_call`, `function_call_output`. Both
  shapes must be projected.
- `response_item.payload.type=="reasoning"` may carry
  `encrypted_content`. Treat as opaque; do not assume the text is
  readable.
- `event_msg.exec_command_end.stdout/stderr/formatted_output/aggregated_output`
  can be very large. The importer routes them to the CAS via
  `stageText` and references the resulting `object_id` in
  `tool_results.stdout_object_id` / `stderr_object_id` / `output_object_id`
  rather than inlining.
- Subagents are stored as ordinary session files; their parent is in
  `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`.
  Project as a `sessions` row with `is_subagent=1` and a `spawned` edge
  from the parent session.
- There is no `sessions-index.json` analog under `~/.codex/sessions/`.
  Discovery is direct filesystem walk.
- Some legacy records appear as `{"record_type":"state"}` without a
  `type` key — these are markers, not chat content. Skip from messages
  but still preserve as `raw_records`.
