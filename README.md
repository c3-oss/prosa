# prosa

Local-first compiler that turns fragmented agent session histories — Cursor
Agent, Codex CLI, Claude Code, Gemini CLI — into a single canonical store
(format **W**) you can search, filter, audit, and export.

> Status: MVP in progress. Codex importer first; Claude/Gemini/Cursor staged
> next. TUI and MCP server are planned but not yet implemented.

## Quick start

```bash
devbox shell
pnpm install
pnpm build

prosa init                        # creates ~/.prosa/
prosa compile --codex ~/.codex/sessions
prosa sessions --since 2026-01-01
prosa search "terraform"
prosa export session <id> --format markdown
```

## Architecture

`prosa` follows the local bundle layout recommended for this kind of store:

```
~/.prosa/
  manifest.json           # version, parser_version, created_at
  prosa.sqlite            # canonical catalog + projections + FTS5
  objects/blake3/ab/cd/<hash>.zst    # content-addressed object store
  raw/sources/<hash>.zst             # preserved copies of source files
  exports/                # markdown / json / csv exports
```

The SQLite database is the catalog. Big content (raw JSONL records, tool
outputs, diffs) is stored in `objects/` keyed by BLAKE3 hash. Source files are
preserved verbatim in `raw/sources/` so projections can be rebuilt by a future,
better importer without re-reading the originals.

## Why this exists

Every agent CLI keeps history in its own format. Searching across them is
painful, auditing tool calls is harder, and exporting human-readable
transcripts is mostly impossible. `prosa` reduces that noise into one
queryable store while preserving every original byte for re-processing.

See `cli-prosa.md` and `gpt-5-pro-response.md` in this repo for the design
rationale and the per-tool reverse engineering reports.
