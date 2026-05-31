# Canonical session mapping

This document is the contract every prosa importer fills out. The two domain
types — `session.Session` and `session.Turn` (defined in `pkg/session/types.go`)
plus the `session.ToolUsage` aggregate — are agent-agnostic. Per-agent JSONL
formats project into them.

When introducing a new agent, add a column / section here so the next reader
can see how each field is resolved without spelunking through importer code.

## Turn shape

`session.Turn` carries:

| Field | Notes |
|---|---|
| `Role` | `user` \| `assistant` \| `tool` |
| `Content` | searchable text (tool outputs are truncated to a preview — raw stays on disk) |
| `Timestamp` | per-record time |
| `Kind` | `message` \| `tool_result` \| `operational`; empty reads as `message` |
| `ToolName` | populated when `Kind = tool_result`; empty otherwise |

Importers tag user/assistant chat as `KindMessage` and projected tool
outputs as `KindToolResult` with `ToolName` resolved via the agent's
own call-id linkage. Anything binary, image-only, or thinking-only
stays excluded.

## Projection version

`session.ProjectionVersion = 5`. The server's push handler compares
`projection_version >= session.ProjectionVersion` before short-
circuiting, so bumping this constant forces existing sessions to be
re-projected on the next push from any client — no schema migration
needed for downstream consumers.

| Version | Brought |
|---|---|
| 1 | initial cut |
| 2 | usage projection (`session_usage`) |
| 3 | `turn.kind` / `turn.tool_name`, sessiontext-cleaned `FirstPrompt` |
| 4 | importer-level no-usage filtering; Claude Code `<synthetic>` model exclusion |
| 5 | ANSI/control-char strip in `FirstPrompt` + recognize `<local-command-stdout/stderr>`; cursor/gemini/hermes routed through `sessiontext` |

## Import eligibility

Importers persist only sessions with measured token usage. A session is
eligible when its projected `session.TokenUsage` has at least one positive
token field. Files with no usage signal return `Skipped` with reason
`no_usage`; they are not upserted, their turns/tool counts are not written,
and their raw source is not copied. Local stores remember these policy
skips by `(session_id, reason, hash)` so unchanged no-usage files can be
skipped without re-parsing on later runs.

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
| `Model` | first `type:assistant` record's non-`<synthetic>` `message.model` |
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

## Cursor

Source: `~/.cursor/chats/<workspace-id>/<agent-id>/store.db`. Each store
is a SQLite database with two tables: `meta` (a single hex-encoded JSON
header row) and `blobs` (chat messages, plain text, and protobuf state
keyed by sha256-ish hex ids). The full reference is `docs/sources/cursor.md`.

### `session.Session`

| Field | Source |
|---|---|
| `ID` | `meta.agentId` (decoded from `meta.value` at `key='0'`); fallback: parent directory name (`<agent-id>`) |
| `Agent` | constant `"cursor"` |
| `DeviceID` | `device.IDOnce()` |
| `ProjectPath` | not recorded by Cursor; filled by `internal/projectid` against the cwd at sync time (nil cross-device) |
| `StartedAt` / `LastActivityAt` | both equal `meta.createdAt` (Unix ms, UTC) — Cursor blob rows carry no per-message timestamp |
| `FirstPrompt` | first `blobs.data` JSON object with `role=="user"` whose `content[].text` is non-empty; whitespace-collapsed + truncated to 200 runes |
| `Model` | `meta.lastUsedModel` (when present) |
| `RawPath` / `RawHash` / `RawSize` | sha256 of `store.db`; copy to `$PROSA_HOME/raw/cursor/<YYYY>/<MM>/<session-id>.db` |

### `session.Turn`

| Role | Source |
|---|---|
| `user` | `blobs.data` JSON object with `role=="user"`; text = `content[*].text` joined by `\n` (or the string form of `content` when not an array) |
| `assistant` | same shape with `role=="assistant"` |
| `tool` / `system` | **Skipped** in cut 3. `tool` rows echo tool results; `system` rows carry session-level prompts. Re-evaluate when search needs them |

Every projected turn shares the same `Timestamp == meta.createdAt` because Cursor blobs are not chronologically ordered on disk.

### `session.ToolUsage`

| Field | Source |
|---|---|
| `Name` | `content[].type=="tool-call".toolName` inside any message blob's content array |
| `Count` | aggregated per name within the session |

### Excluded from cut 3

- Protobuf root state (`meta.latestRootBlobId` → blob). Carries the canonical message ordering; without decoding it, on-disk blob order is the only signal and `StartedAt == LastActivityAt`.
- Plain-text blobs (diffs, code, paths) and any blob whose first byte is not `{` or `[`. Preserved in raw, ignored by the projection.
- JSON blobs without a `role` field (root nodes, indices). Same.
- `tool`-role messages and any non-`text` content item (`tool-call` items are counted in `ToolUsage` but their bodies are not echoed as turn text).
- `WAL`/`SHM` siblings of `store.db`. Not copied into raw; Cursor's checkpoint behavior is enough for the projection contract.

### Implementation pointer

`internal/importers/cursor/` follows the four-file shape: `importer.go` (Import wrapper, sha256-based idempotency), `walk.go` (yields every `store.db` under root, skipping siblings), `parse.go` (opens SQLite with `mode=ro&immutable=1` via `modernc.org/sqlite`, decodes the hex meta, classifies blobs), `raw.go` (write-tmp + rename copy of the `.db` only).

## Gemini CLI

Source: `~/.gemini/tmp/<projectHash-or-slug>/` containing either
`chats/session-*.json` (one envelope object per file) or `logs.json` (a
flat array of standalone records). The full reference is `docs/sources/gemini.md`.

### `session.Session`

| Field | Source |
|---|---|
| `ID` | envelope: `sessionId`. Live array: the `sessionId` of the **dominant group** (most rows for any single id in the file). Fallback for both: filename stem |
| `Agent` | constant `"gemini"` |
| `DeviceID` | `device.IDOnce()` |
| `ProjectPath` | not recorded by Gemini in the session; filled by `internal/projectid` against the cwd at sync time. The sibling `.project_root` file is observed but **not** consumed today |
| `StartedAt` | envelope: `startTime`; live: earliest message `timestamp`. Falls back to the first message timestamp seen during projection if the top-level header field is missing |
| `LastActivityAt` | envelope: `lastUpdated`; live: latest message `timestamp`. RFC3339Nano then RFC3339, UTC after parse |
| `FirstPrompt` | first `messages[].type=="user"` (envelope) or `type=="user"` row (live) with non-empty text; whitespace-collapsed + truncated to 200 runes |
| `Model` | envelope: first assistant message's `model`; live: first assistant-side `model` encountered |
| `RawPath` / `RawHash` / `RawSize` | sha256 of the source `.json`; copy to `$PROSA_HOME/raw/gemini/<YYYY>/<MM>/<session-id>.json` |

### `session.Turn`

| Role | Source |
|---|---|
| `user` | `type=="user"` → text from `content` (string or `content[*].text`) for the envelope; from `message` (or `content` as fallback) for the live array |
| `assistant` | `type=="gemini"` → text from the same fields |
| `info` / `error` | **Skipped** in cut 4. Operational records, not chat turns. Reappear later as `Role: "operational"` if reports need them |

Timestamps are per-message in both shapes.

### `session.ToolUsage`

| Field | Source |
|---|---|
| `Name` | `messages[].toolCalls[].name` (envelope only — the live `logs.json` shape carries user prompts, not assistant tool invocations) |
| `Count` | aggregated per name within the session |

### Excluded from cut 4

- `messages[].thoughts[]` — model reasoning. Preserved in raw, hidden from turns.
- `messages[].toolCalls[].args` / `.result` / `.resultDisplay` payloads. Counted via `ToolUsage`, body not echoed.
- `info` and `error` messages. Routed to operational events in a future cut.
- The `logs.json` rows belonging to non-dominant `sessionId`s in the same file. Preserved in raw, dropped from the projection.
- `~/.gemini/tmp/<slug>/.project_root`. The importer does not consume it for `ProjectPath` today (the file is observed only).
- The bundled `~/.gemini/tmp/bin/rg` binary. Not session data; never yielded by Walk.

### Implementation pointer

`internal/importers/gemini/` matches the four-file shape: `importer.go` (Import wrapper, sha256 idempotency), `walk.go` (yields `logs.json` plus every `session-*.json`), `parse.go` (dispatches on JSON shape — envelope vs. flat array — and applies the dominant-session rule to live arrays), `raw.go` (write-tmp + rename copy of the source `.json`).

## Hermes

Source: `~/.hermes/state.db` (canonical SQLite) and `~/.hermes/sessions/` (sibling
directory holding top-level `*.jsonl` transcripts, `session_*.json` snapshots,
and a `sessions.json` index). The full reference is `docs/sources/hermes.md`.

### `session.Session`

| Field | Source |
|---|---|
| `ID` | `state.db` rows: `sessions.id`. `.jsonl`: filename stem. `session_*.json`: `session_id` field; fallback: filename stem with the `session_` prefix stripped |
| `Agent` | constant `"hermes"` |
| `DeviceID` | `device.IDOnce()` |
| `ProjectPath` | not recorded by Hermes; filled by `internal/projectid` against the cwd at sync time |
| `StartedAt` | `sessions.started_at` (Unix seconds REAL → UTC) for SQLite rows. `session_start` for JSON snapshots. Earliest message `timestamp` for JSONL. Per-message timestamps may be Unix seconds or ISO strings |
| `LastActivityAt` | `sessions.ended_at` when set; otherwise the latest message timestamp. `last_updated` for JSON snapshots |
| `FirstPrompt` | first `messages.role=="user"` row (SQLite) or first user line/message (JSONL/JSON) with non-empty `content` (text or first text item of an array); whitespace-collapsed + truncated to 200 runes |
| `Model` | `sessions.model` (SQLite); `model` (JSON snapshot); first assistant-side `model` encountered (JSONL) |
| `RawPath` / `RawHash` / `RawSize` | sha256 of the source file; copy to `$PROSA_HOME/raw/hermes/<YYYY>/<MM>/<session-id>.<ext>` where `<ext>` is `db`, `jsonl`, or `json`. For `state.db`, one raw copy per session id — all copies are byte-identical |

### `session.Turn`

| Role | Source |
|---|---|
| `user` | `messages.role=="user"` / `messages[].role=="user"`. Content = string `content` or first text item of a content array |
| `assistant` | `messages.role=="assistant"` / `messages[].role=="assistant"`. Same shape |
| `tool` / `system` | **Skipped** in cut 5. `tool` rows are tool-result echoes; `system` rows carry session-level prompts. Reappear when search needs them |

### `session.ToolUsage`

| Field | Source |
|---|---|
| `Name` | `messages.tool_calls` JSON array → each element's `name` field. Shape is OpenAI-style `[{type, function:{name, arguments}}]` or the flat `[{name, arguments}]` variant Hermes also emits; both project to the same name |
| `Count` | aggregated per name within the session |

### Excluded from cut 5

- Hidden reasoning columns: `messages.reasoning`, `messages.reasoning_content`, `messages.reasoning_details`, `messages.codex_reasoning_items`, `messages.codex_message_items`. Preserved in raw, never projected to turns.
- `sessions.system_prompt`, `sessions.model_config`, `sessions.end_reason`, `sessions.title`. Preserved in raw, not yet on `session.Session`.
- `sessions.parent_session_id`. Captured in raw; not surfaced as a subagent edge today (no `is_subagent` column on `session.Session`).
- `~/.hermes/sessions/sessions.json`. Observed as an index; never yielded by Walk and never projected.
- Nested directories under `~/.hermes/sessions/` (e.g. `saved/`). Walk is intentionally non-recursive.
- **Dual-source dropped side**: when both `state.db` and a sibling `<id>.jsonl` / `session_<id>.json` describe the same session, the source with more messages wins. The other side is preserved in raw but not in the projection.

### Implementation pointer

`internal/importers/hermes/` matches the four-file shape, with a wider `parse.go`: `importer.go` dispatches on filename (`state.db`, `*.jsonl`, `session_*.json`); `walk.go` is non-recursive and yields the sibling `state.db` at `<root>/../state.db` plus top-level `.jsonl` and `session_*.json` files; `parse.go` opens SQLite with `mode=ro&immutable=1` for the multi-row state.db path, decodes JSONL with a `bufio.Scanner` for transcripts, and applies the message-count merge rule before each state.db row's projection; `raw.go` takes an explicit `ext` so the same state.db source produces N `<id>.db` raws (one per session id) without re-deriving the extension.
