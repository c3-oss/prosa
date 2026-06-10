# Claude Code source format

Claude Code stores per-project session histories as JSONL files under
`~/.claude/projects/`, plus subagent JSONL files, large tool-result
artifacts, optional project memory, and an auxiliary index.

Imported by `packages/prosa-core/src/importers/claude/`.

## Layout

```text
~/.claude/projects/
  <project-slug>/
    <session-id>.jsonl                         # main session
    sessions-index.json                        # auxiliary index (incomplete)
    memory/*.md                                # project memory
    <session-id>/
      subagents/
        agent-<agent-id>.jsonl                 # subagent transcript
        agent-<agent-id>.meta.json             # subagent metadata
      tool-results/
        *.txt | *.json | pdf-<id>/page-NN.jpg  # large outputs and PDFs
```

`<project-slug>` is derived from the project's filesystem path but is
**not** reversibly decodable — `/`, `_`, `.`, and spaces all round-trip
to `-`. Resolve real paths via, in order:

1. `sessions-index.json -> entries[].projectPath` (best when present)
2. `sessions-index.json -> originalPath`
3. Any `cwd` field inside a session's JSONL records

## Identity

| Field | Source |
|---|---|
| Session id | Filename of the main JSONL = `sessionId` inside |
| Subagent | `<session-id>/subagents/agent-<agent-id>.jsonl`; `agentId`, `isSidechain: true`, same `sessionId` as parent |
| Real project path | `entries[].projectPath` in `sessions-index.json`, then `cwd` |
| Subagent type | `<...>.meta.json -> agentType` (`Explore`, `Plan`, `general-purpose`, …) |

`sessions-index.json` is **incomplete** in practice (entries cover main
sessions only and not always all of them). Always discover sessions by
walking `*.jsonl`; treat the index as a hint.

## Record format

Each line is one JSON object. Top-level `type` discriminates:

```text
assistant, user, progress, file-history-snapshot, attachment, system,
permission-mode, last-prompt, queue-operation, agent-name,
custom-title, pr-link
```

### Common envelope fields

```text
type, sessionId, timestamp, cwd, gitBranch, isSidechain, parentUuid,
userType, uuid, version, slug, message, agentId, requestId, entrypoint,
sourceToolAssistantUUID, promptId, toolUseID, parentToolUseID,
toolUseResult, isMeta, …
```

`uuid` identifies the event; `parentUuid` links to the previous one.

### `user`
`message.content` is either a string (plain prompt) or an array. Array
form may contain `tool_result` blocks coming back from earlier
assistant tool calls.

### `assistant`
`message` carries `model`, `id`, `role`, `content[]`, `stop_reason`,
`usage`. `content[]` block types observed:

```text
text, thinking, tool_use, tool_result, image
```

`message.model == "<synthetic>"` is a Claude Code placeholder observed on
synthetic assistant records such as login/status scaffolding. It is not a
real model name and must not become the canonical session model; keep
scanning for the first non-placeholder assistant model.

### Content blocks

| Block | Shape |
|---|---|
| `text` | `{ type, text }` |
| `thinking` | `{ type, thinking, signature }` — model reasoning |
| `tool_use` | `{ type, id, name, input }` — assistant invokes a tool |
| `tool_result` | `{ type, tool_use_id, content, is_error }` — usually inside `user` events |
| `image` | inline image |

Tool calls and results match on `tool_use.id == tool_result.tool_use_id`.
Results may also appear as a top-level `toolUseResult` field with a more
structured shape (e.g. for `Bash`: `{ stdout, stderr, interrupted,
isImage }`; for `Read`: `{ type, file: { filePath, content, numLines, … } }`).

### `system`
Operational events, **not** system prompts. Subtypes include
`turn_duration`, `stop_hook_summary`, `local_command`, `api_error`,
`scheduled_task_fire`, `compact_boundary`, `bridge_status`,
`informational`. Project as `messages.role='operational'` (or as
`events.event_type='system_operational'`), never as `system_prompt`.

### Other types

- `progress` — `data.type ∈ {hook_progress, agent_progress, bash_progress, query_update, search_results_received}`. Routed to `events`.
- `attachment` — `attachment.type ∈ {file, task_reminder, deferred_tools_delta, skill_listing, nested_memory, queued_command, hook_success, plan_mode, …}`.
- `file-history-snapshot` — projection of a file at a moment; goes to `artifacts`.
- `permission-mode`, `last-prompt`, `queue-operation`, `agent-name`,
  `custom-title`, `pr-link` — small operational events.

## Tool-results artifacts

Large outputs are saved out-of-band:

```text
<project-slug>/<session-id>/tool-results/<file>
```

The JSONL message often contains only a preview plus
`Full output saved to: …`. Image-bearing PDFs land as
`tool-results/pdf-<uuid>/page-NN.jpg`.

## Reading recipes

```bash
proj="$HOME/.claude/projects/<project-slug>"
session="$proj/<session-id>.jsonl"
```

**Validate every JSONL parses:**

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
  while IFS= read -r -d '' f; do
    jq -c . "$f" >/dev/null || echo "invalid: $f"
  done
```

**User prompts in main sessions:**

```bash
find ~/.claude/projects -type f -name '*.jsonl' -not -path '*/subagents/*' -print0 |
  xargs -0 jq -r '
    select(.type=="user" and (.message.content|type)=="string") |
    [.timestamp, .sessionId, .cwd, .message.content] | @tsv'
```

**All assistant text from one session:**

```bash
jq -r 'select(.type=="assistant") |
  .message.content[]? | select(.type=="text") | .text' "$session"
```

**All tool calls (across main and subagents):**

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.message.content|type=="array") |
    .message.content[]? | select(.type=="tool_use") |
    [input_filename, .id, .name, (.input|tostring)] | @tsv'
```

**Bash commands executed:**

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.message.content|type=="array") |
    .message.content[]? | select(.type=="tool_use" and .name=="Bash") |
    [input_filename, .id, (.input.command // "")] | @tsv'
```

**Errored tool results:**

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.message.content|type=="array") |
    .message.content[]? | select(.type=="tool_result" and (.is_error == true)) |
    [input_filename, .tool_use_id, (.content|tostring|.[0:300])] | @tsv'
```

**Search across everything (JSONL + artifacts + memory):**

```bash
rg -n "term" ~/.claude/projects -g '*.jsonl' -g '*.json' -g '*.txt' -g '*.md'
```

**Subagent calls in main sessions:**

```bash
find ~/.claude/projects -type f -name '*.jsonl' -not -path '*/subagents/*' -print0 |
  xargs -0 jq -r '
    select(.message.content|type=="array") |
    .message.content[]? | select(.type=="tool_use" and .name=="Agent") |
    [input_filename, .id, (.input.subagent_type // ""),
     (.input.description // ""), ((.input.prompt // "") | length)] | @tsv'
```

**Reconstruct a timeline (timestamp, type, uuid, parent):**

```bash
jq -r '[.timestamp, .type, (.message.role // ""), (.message.model // ""),
        (.uuid // ""), (.parentUuid // "")] | @tsv' "$session"
```

**Render a session as Markdown:**

```bash
jq -r '
  if .type == "user" and (.message.content|type) == "string" then
    "USER:\n" + .message.content + "\n"
  elif .type == "assistant" then
    (.message.content[]? | select(.type=="text") | "ASSISTANT:\n" + .text + "\n")
  else empty end' "$session"
```

`prosa v1 export session <session-id> --format markdown` produces a
metadata-rich version with tool-call summaries.

## Notes for prosa importers

- Walk `*.jsonl` directly. `sessions-index.json` is a hint, never the
  source of truth.
- Subagents are the majority of files in active workspaces. Include
  `*/subagents/*.jsonl` in any global query.
- `type: "system"` is operational. Project to
  `messages.role='operational'`, never `system_prompt`.
- `FirstPrompt` and projected user turns pass through
  `internal/sessiontext.CleanPrompt` so a single user message wrapping
  a real prompt inside `<local-command-caveat>…</local-command-caveat>`
  resolves to the human content, not the wrapper. Wholly-meta user
  messages (`<command-name>`, `<system-reminder>`, etc.) fall through
  and the renderer shows `(meta)` instead.
- `tool_result` blocks inside user-role messages project as
  separate `Role: "tool"`, `Kind: "tool_result"` turns. `ToolName`
  comes from the matching assistant `tool_use.id` → `name` map.
  Content is truncated to `toolPreviewMaxLines` /
  `toolPreviewMaxBytes` (constants in
  `internal/importers/claudecode/parse.go`). Binary / image
  content is still excluded; the raw JSONL stays untouched.
- Large outputs may live entirely in `tool-results/`; the JSONL contains
  a preview and a path. Project them as `artifacts` and reference the
  CAS object from `tool_results.output_object_id` (or
  `artifacts.object_id`).
- The graph is built from `uuid` / `parentUuid` for messages,
  `sessionId` / `agentId` / `isSidechain` for sessions, and
  `tool_use.id` ↔ `tool_result.tool_use_id` for tool pairs.
  `sourceToolAssistantUUID` ties subagent-side artifacts to the
  parent-side assistant message.
- Project slug → real path is not reversible; always read
  `cwd` / `entries[].projectPath` if you need the actual filesystem path.
- The `toolUseResult` top-level field can hold a more structured copy of
  what's also in `content[].tool_result`. The importer prefers
  `toolUseResult` for structured payloads and falls back to the content
  block.

## Transcript fidelity

What `loadTranscript` / `prosa v1 session show` surface for Claude Code sessions:

- **Preserved verbatim**: `content[].type='text'` blocks (user + assistant),
  `content[].type='tool_use'` arguments, and the matched `tool_result`
  payloads. Image and unknown block types are kept as content blocks so the
  raw shape is reachable.
- **CAS (`text_object_id` / `*_object_id`)**: large tool outputs land in
  `tool_results.output_object_id` (and may also appear as
  `artifacts.object_id` for entries that arrived via `tool-results/`).
  Long assistant text bodies past the inline limit live in
  `content_blocks.text_object_id`.
- **Thinking projected (v7+)**: `content[].type='thinking'` is
  imported as `Turn{Role:"assistant", Kind:KindThinking, Content:<truncated to 4 KB>}`,
  one turn per thinking block, preserving source order. The panel
  renders these as collapsed "Processed" cards in the sidepanel; FTS
  excludes `kind='thinking'` rows (local `turns_fts` triggers gate on
  `WHEN kind != 'thinking'`; server `content_tsv` returns empty for
  thinking) so search results stay focused on chat content. The raw
  JSONL preserves every byte verbatim.
- **Subagents projected (v8+)**: subagent JSONLs at
  `<parent-uuid>/subagents/agent-<uuid>.jsonl` are imported
  alongside their parents (the walker includes the `subagents/`
  directory; basename must match `agent-<uuid>.jsonl`). The parent
  UUID is recovered from the directory two levels above the JSONL
  and stored in `Session.ParentSessionID`. The panel renders the
  Subagents disclosure on the parent's sidepanel; clicking a child
  reopens the same sidepanel scoped to it.
- **Summarized vs verbatim**: `tool_results.preview` is a short snapshot
  of the result text; the verbatim payload is reachable via
  `*_object_id`. Subagent-side artifacts cross-link to the parent assistant
  message via `sourceToolAssistantUUID`.
- **Gaps**: `type='system'` events are projected as
  `messages.role='operational'`, not `system_prompt`, so consumers that
  look only at `role='system_prompt'` miss them.
