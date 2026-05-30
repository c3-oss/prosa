---
name: prosa-cli-rendering
description: CLI behavior and rendering conventions for prosa. Use when changing internal/cli commands, flags, timeline/search rendering, TTY behavior, or progress output.
---

# Prosa CLI Rendering

Use this skill before changing CLI command behavior or user-visible terminal
output.

## CLI contract

`INTENT.md` section 8 defines the public CLI shape. The current cut includes:

- `prosa` — renders the local timeline.
- `prosa sync` — scans registered agents and imports sessions.
- `prosa search <query>` — searches FTS5 content.
- `prosa show <session-id>` — prints preserved raw JSONL.

Global flags:

- `--last`
- `--project`
- `--device`
- `--agent`
- `--all`
- `--json`

Keep flags stable even if later cuts wire them more deeply.

## Rendering rules

- Timeline/search are one-shot renderers; no resident TUI.
- TTY output may use Lipgloss colors and responsive truncation.
- Non-TTY output must be plain text or NDJSON without escape codes.
- `prosa sync` may use Bubble Tea progress in interactive terminals, with a
  plain structured fallback for cron/LaunchAgent/systemd use.
- Do not print logs to stdout when stdout is carrying command output.

## Project scoping

When not using `--all`, read commands may auto-scope to the detected project
from the cwd. Make that scoping visible on stderr for human output and silent
for JSON/NDJSON output.

## Testing

CLI/rendering changes should cover both interactive and non-interactive paths
where practical:

- JSON/NDJSON output remains machine-readable.
- Plain output contains no ANSI escapes.
- Long titles/projects truncate without breaking alignment.
- Date headers and active-session markers stay consistent with `INTENT.md`.

Run `go test ./internal/cli/...` and `just test-race`.
