# Source formats

Each AI coding agent prosa imports from has its own on-disk layout and its
own JSONL shape. This directory documents those — one file per agent.

These are **observation docs**, not contracts we control. The agents own
the formats; prosa observes them. When an agent ships a breaking format
change, the corresponding file here gets updated and the importer adapts.

## Inventory

| Agent | Doc | Importer |
| --- | --- | --- |
| Antigravity CLI | [antigravity.md](antigravity.md) | `internal/importers/antigravity/` |
| Claude Code | [claude-code.md](claude-code.md) | `internal/importers/claudecode/` |
| Codex | [codex.md](codex.md) | `internal/importers/codex/` |
| Cursor | [cursor.md](cursor.md) | `internal/importers/cursor/` |
| Gemini CLI | [gemini.md](gemini.md) | `internal/importers/gemini/` |
| Hermes | [hermes.md](hermes.md) | `internal/importers/hermes/` |

## What each file covers

A source-format doc describes:

1. **Where to find the sessions** — default root paths per platform.
2. **File naming** — how a session's filename maps to identity.
3. **JSONL shape** — the record types we care about, with examples.
4. **Identity fields** — where the session ID, started_at, last_activity,
   model, project context, and first prompt come from.
5. **Tool calls and turns** — how the JSONL distinguishes user/assistant
   text from tool invocations and results.
6. **Quirks** — anything the importer has to special-case (renames,
   subagent files, sidecars).

## Mapping into prosa

Every importer maps the source into the canonical session shape defined in
[`../architecture/canonical-session.md`](../architecture/canonical-session.md).
The fields are the same across agents; the **mappings** differ.

If a source format exposes something that doesn't fit the canonical shape
(yet), the importer drops it. It does **not** extend the schema unilaterally.
Schema extensions are an INTENT-level conversation.

## Adding a new source

When you write a new source doc, follow the shape of
[claude-code.md](claude-code.md). Keep it concrete: paths, filenames, JSON
keys, example records. No vibes-based descriptions ("usually has a model
field somewhere"). If a field isn't reliably present, say so and document
the fallback.

For the matching code work, see
[`../contributing.md#adding-a-new-importer`](../contributing.md#adding-a-new-importer).
