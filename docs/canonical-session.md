# Canonical session mapping

This document is the contract every prosa importer fills out. The two domain
types — `session.Session` and `session.Turn` (defined in `pkg/session/types.go`)
plus the `session.ToolUsage` aggregate — are agent-agnostic. Per-agent JSONL
formats project into them.

When introducing a new agent, add a column / section here so the next reader
can see how each field is resolved without spelunking through importer code.

## Claude Code

Source: `~/.claude/projects/<project-slug>/<session-id>.jsonl`. Each line is
a JSON object discriminated by `type`. The full envelope reference is
`docs/sources/claude-code.md`.

### `session.Session`

| Field | Source |
|---|---|
| `ID` | `<session-id>` basename of the JSONL file (UUID); also matches the `sessionId` field inside records |
| `Agent` | constant `"claude-code"` |
| `DeviceID` | constant `"local"` in cut 1 (fingerprint lands with sync) |
| `ProjectPath` | first non-empty `cwd` encountered on any record |
| `StartedAt` | `min(timestamp)` over all records (RFC 3339, UTC after parse) |
| `LastActivityAt` | `max(timestamp)` over all records |
| `FirstPrompt` | first `type:user` record whose `message.content` is a string and `isMeta != true`; truncated to 200 runes with a trailing `…` |
| `Model` | first `type:assistant` record's `message.model` |
| `RawPath` | importer's destination after copy: `$PROSA_HOME/raw/claude-code/<YYYY>/<MM>/<id>.jsonl` (year/month from `StartedAt`) |
| `RawHash` | sha256 of the source file bytes at import time |
| `RawSize` | source file size at import time |

### `session.Turn` (FTS signal only)

Cut 1 populates `turns` only with the text that drives full-text search.
Tool calls, tool results, thinking blocks, and operational events are
excluded — they remain reachable via the preserved raw JSONL.

| Field | Source |
|---|---|
| `Role` | `"user"` for `type:user` records (string content); `"assistant"` for `type:assistant` records with at least one `content[].type == "text"` block |
| `Content` | for user: the `message.content` string verbatim. For assistant: `content[].text` blocks joined by `\n` |
| `Timestamp` | the record's `timestamp` |

### `session.ToolUsage`

Aggregated across the file: name → invocation count.

| Field | Source |
|---|---|
| `Name` | `tool_use.name` inside any `message.content[]` array (user `tool_result` echoes do not count) |
| `Count` | number of `tool_use` blocks with that name in the session |

### Excluded from cut 1

- `type:system` (operational events). Will project to a future `Role: "operational"` when search needs them.
- `type:assistant` `thinking` content blocks (kept hidden by default in v2; same intent here).
- `type:assistant` `tool_use` / user-side `tool_result` content (counted in `ToolUsage`, not echoed as text).
- Subagent JSONL files under `<session-id>/subagents/`. The walker skips this whole subtree.
- Large tool-result artifacts in `tool-results/`. Out of scope until cut 3 (artifact projection).

## Codex CLI

Source: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<local-date>T<local-time>-<UUID>.jsonl`.
Each line is one JSON object, in **one of two shapes** the parser handles:

- **Envelope** (modern files): `{type, timestamp, payload}` where `type ∈ {session_meta, turn_context, response_item, event_msg, compacted}`.
- **Legacy** (older files): bare `{type: "message"|"function_call"|...}` at top level with no `payload` wrapper. The fields that would live under `payload` sit directly on the record.

The full envelope reference is `docs/sources/codex.md`.

### `session.Session`

| Field | Source |
|---|---|
| `ID` | envelope: `session_meta.payload.id`. Legacy/missing meta: UUID suffix of the filename (`...-<UUID>.jsonl`) |
| `Agent` | constant `"codex"` |
| `DeviceID` | constant `"local"` in cut 2 |
| `ProjectPath` | first non-empty of `session_meta.payload.cwd`, then `turn_context.payload.cwd` |
| `StartedAt` / `LastActivityAt` | `min`/`max` of every record's top-level `timestamp` (both envelope and legacy carry it) |
| `FirstPrompt` | first `response_item.payload.type=="message"` with `role=="user"` and non-empty `content[*].input_text` (legacy: first `{type:"message", role:"user"}`); whitespace-collapsed + truncated to 200 runes |
| `Model` | first `turn_context.payload.model` |
| `RawPath` / `RawHash` / `RawSize` | identical pattern to claudecode (sha256 + os.Stat; copy to `$PROSA_HOME/raw/codex/<YYYY>/<MM>/<id>.jsonl`) |

### `session.Turn`

| Role | Source |
|---|---|
| `user` | envelope: `response_item.payload.type=="message"` with `role=="user"` → `content[*].input_text` joined by `\n`. Legacy: `{type:"message", role:"user", content}` where content is a string or `[{text}]` array. |
| `assistant` | envelope: same record with `role=="assistant"` → `content[*].output_text`. Legacy: `{type:"message", role:"assistant", content}` projected the same way. |
| `developer` role | **Skipped** in cut 2 (carries templated instructions; analogous to Claude Code's `system` events). Re-evaluate when search results show gaps. |

### `session.ToolUsage`

| Field | Source |
|---|---|
| `Name` | envelope: `response_item.payload.type=="function_call".name`. Legacy: top-level `{type:"function_call", name}`. |
| `Count` | aggregated per name within the session |

### Excluded from cut 2

- `developer`-role messages (see note above).
- `response_item.payload.type=="reasoning"` (carries `encrypted_content`; opaque).
- `event_msg` operational events (exec_command_end, token_count, agent_reasoning, etc.). Their structured payloads live in the preserved raw — projection into a future `Role: "operational"` plus structured `tool_results.output_object_id` lands when reports need them.
- Subagent linkage: Codex subagents are ordinary session files; the parent thread id at `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` is **not** projected (no `is_subagent` column yet).
- Legacy `{record_type: "state"}` markers — preserved in raw, ignored by the parser.

### Implementation pointer

`internal/importers/codex/` mirrors `internal/importers/claudecode/`: `importer.go` (Import wrapper), `walk.go` (filename regex), `parse.go` (streaming JSONL with 16 MiB scan buffer; handles envelope + legacy in one loop), `raw.go` (write-tmp + rename copy). The `Importer` and `Sink` interfaces in `pkg/importer/` are unchanged across agents.
