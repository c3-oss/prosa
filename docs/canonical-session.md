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

## Codex (placeholder — cut 2)

The Codex JSONL format does not map directly onto Claude Code's envelope.
When the Codex importer lands, add a column here mirroring the Claude one.
Expected differences (from `docs/sources/codex.md`):

- Records use `type:"response.completed"` (and friends) instead of `assistant`. Assistant text is at `response.output[*].content[*].text`, not `message.content[]`.
- No top-level `cwd` per record — `ProjectPath` resolves from a per-session metadata file in `~/.codex/sessions/`.
- Model id is `response.model`, not `message.model`.
- Tool calls / results show up as `function_call` / `function_call_output` records, not embedded blocks inside an assistant message.

The `Importer` and `Sink` interfaces in `pkg/importer/` are unchanged across
agents; only the per-agent projection in `internal/importers/<name>/` differs.
