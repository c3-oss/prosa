# Grok Build source format

Grok Build is xAI's CLI coding agent (binary `grok`). It stores every
session as a **directory** under `~/.grok/sessions/`, one per conversation,
with session metadata, chat history, and the usage/cost ledger split across
three files. Surveyed against grok v1.0.3 on a live store of 105 sessions.

## Layout

```
~/.grok/
└── sessions/
    ├── session_search.sqlite            search index — ignored
    └── <percent-encoded-cwd>/           one dir per project cwd
        ├── prompt_history.jsonl         project-level history — ignored
        └── <uuidv7>/                    one dir per session
            ├── summary.json             metadata (the import anchor)
            ├── chat_history.jsonl       chat records, no timestamps
            ├── updates.jsonl            event ledger incl. usage/cost
            ├── events.jsonl             UI event stream — ignored
            ├── signals.json             — ignored
            ├── terminal/                — ignored
            ├── subagents/<child-id>/    per-spawn metadata (meta.json)
            └── *.lock                   — ignored
```

The project directory name is the percent-encoded cwd
(`%2FUsers%2Fme%2Fproject`). The session directory basename equals
`summary.info.id` (a uuidv7). Subagent sessions get their **own**
session directory at the same depth as top-level ones, plus a
`subagents/<child-id>/meta.json` entry under the parent's directory.

`prompt_history.jsonl` is project-level (outside any session dir), misses
subagent children, and sits outside the per-session hash — importers must
not read it.

## Identity

`summary.json` carries the session identity:

| Key | Meaning |
| --- | --- |
| `info.id` | session id (uuidv7; equals the directory basename) |
| `info.cwd` | working directory (decoded form of the project dir name) |
| `created_at` / `updated_at` | ISO-8601 timestamps, always present |
| `last_active_at` | ISO-8601; missing in a small minority of sessions |
| `current_model_id` | e.g. `grok-4.5`, `grok-4.6` |
| `generated_title` | model-written title; occasionally empty |
| `git_remotes[]` | remotes of the cwd at session start |
| `session_kind` | `"subagent"` on spawned children; absent on top-level |

`subagents/<child-id>/meta.json` (under the parent session dir) carries
`parent_session_id`, `child_session_id`, `subagent_type`, the delegation
`prompt`, and timing/counters for the spawn.

## Record format — `chat_history.jsonl`

One JSON object per line, discriminated by `type`. The type set is
**open**: new record types appear between grok releases, so consumers must
tolerate unknown types (warn + skip). Observed types:

| `type` | Shape |
| --- | --- |
| `system` | `content` string — the injected system prompt |
| `user` | `content` is an array of `{type:"text", text}` blocks |
| `assistant` | `content` is a plain string; optional `tool_calls[]`; `model_id` (e.g. `grok-4.5-build`) |
| `reasoning` | `summary` is an array of `{type:"summary_text", text}` blocks (may be empty); `encrypted_content` is opaque |
| `tool_result` | `content` is a plain string; `tool_call_id` links to the originating call |
| `backend_tool_call` | server-side tool: `kind.tool_type` (observed `web_search`) plus a `kind.action` payload; no matching `tool_result` line |

Records carry **no timestamps** — ordering is line order.

A user line is a **human turn** exactly when `prompt_index` is present AND
`synthetic_reason` is absent. Everything else is injected context:
`synthetic_reason` values like `project_instructions` / `system_reminder`
mark scaffold, and lines with neither field are injected context blocks.
Human prompts are wrapped in `<user_query>…</user_query>` (one observed
exception: a subagent delegation prompt carries `prompt_index` without the
wrapper).

Assistant `tool_calls[]` entries are `{id, name, arguments}` where
`arguments` is a **JSON-encoded string**. Most tool-calling assistant
records have empty `content` — in the surveyed corpus, 268/619 assistant
records were content-empty yet carried 961/1787 of all tool calls.

Longest observed line: 44 KB.

## Tool inventory

Client-side tools observed: `read_file`, `write_file`, `edit_file`,
`run_terminal_command`, plus MCP-style tool names. Server-side
(`backend_tool_call`) tools observed: `web_search`. The inventory is open,
like the record type set.

## Token usage — `updates.jsonl`

Usage and cost live **only** in `updates.jsonl`, in lines where
`params.update.sessionUpdate == "turn_completed"`:

```json
{"timestamp": 1785813411, "method": "_x.ai/session/update",
 "params": {"sessionId": "<uuid>", "update": {
   "sessionUpdate": "turn_completed",
   "prompt_id": "<uuid>",
   "usage": {
     "inputTokens": 196974, "outputTokens": 2343, "totalTokens": 199317,
     "cachedReadTokens": 178432, "cacheCreationTokens": 0,
     "reasoningTokens": 1573, "modelCalls": 8,
     "costUsdTicks": 1046716000,
     "modelUsage": {"grok-4.5-build": {"...": "same shape"}}}}}}
```

Verified semantics:

- Records are **per-prompt deltas** — sum them, don't take the max.
- `totalTokens == inputTokens + outputTokens`.
- `inputTokens` **includes** cached reads (so uncached input is
  `inputTokens − cachedReadTokens − cacheCreationTokens`).
- `cacheCreationTokens` may be absent → treat as 0.
- `costUsdTicks` is USD × 1e10 (1 tick = 1e-10 USD).
- Records whose `prompt_id` starts with `subagent-completed-` aggregate a
  child session's model calls into the parent's ledger and partially
  duplicate the child's own records — exclude them from sums.

**Parent-aggregates-child caveat**: even after excluding
`subagent-completed-*` records, the parent's regular `turn_completed`
records already fold the child's model calls into their totals (verified:
a parent record's `modelCalls 21 = 11 + 10` across parent and child). At
fleet level a subagent's tokens are therefore counted twice — once in the
child session, once inside the parent's turn. This is accepted and mirrors
how Claude Code sidechains are counted today.

Some sessions have an `updates.jsonl` with zero `turn_completed` records,
and a few have no `updates.jsonl` at all — both mean "no usage signal",
not "zero usage".

## Notes for prosa importers

- **Anchor on `summary.json`** at exactly
  `<root>/<project>/<uuidv7>/summary.json` — depth-3 matching with a
  uuid-shaped parent dir structurally excludes the search index, lock
  files, `terminal/`, `subagents/`, and `prompt_history.jsonl`.
- **Session id** = `summary.info.id`, fallback the directory basename
  (warn on mismatch — the id is what grok's own search index keys on).
- A Grok session is a multi-file directory, so the raw artifact is a
  **canonical projection** (summary, optional subagent meta, chat lines,
  and `turn_completed` lines), not a byte-for-byte copy of a single file —
  see [`../architecture/importers.md`](../architecture/importers.md) for
  the multi-file projection authorization. Usage/cost provenance
  (`costUsdTicks`, `modelUsage`, `reasoningTokens`) survives inside the
  projected `turn_completed` lines.
- **Usage classification**: a session whose only `turn_completed` records
  are `subagent-completed-*` aggregates has no usage signal of its own —
  classify Unknown (admit with nil usage), not ExplicitZero.
- **Parent edge**: for `session_kind == "subagent"`, resolve
  `*/subagents/<child-id>/meta.json` among sibling sessions (project dir
  first, sessions root as fallback) and read `parent_session_id`.
- **Pricing**: `grok-4.5-build` / `grok-4.6-build` resolve to the
  `grok-4.5` / `grok-4.6` rates by prefix. The ≥200K-context 2× input
  surcharge is not modelled — costs for very long contexts are
  underestimated, the same approximation prosa applies to Gemini's
  context tiers.

## References

- Live store survey: 105 sessions, grok v1.0.3, 2026-08.
- Importer: `internal/importers/grokbuild/`.
