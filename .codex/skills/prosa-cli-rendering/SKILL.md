---
name: prosa-cli-rendering
description: CLI behavior and rendering conventions for prosa. Use when changing internal/cli commands, flags, timeline/search rendering, TTY behavior, or progress output.
---

# Prosa CLI Rendering

Use this skill before changing CLI command behavior or user-visible
terminal output.

## CLI contract

The public surface lives in `docs/usage.md`. Today it includes:

- `prosa` — renders the local timeline.
- `prosa sync` — scans registered agents, imports sessions, pushes to
  the server.
- `prosa search <query>` — searches FTS5 content (local or `--remote`).
- `prosa show <session-id>` — prints preserved raw JSONL.
- `prosa analytics <report>` — one of `sessions | tools | models |
  projects | errors`.
- `prosa devices …` — `list | rename | revoke` (cross-device).
- `prosa schedule …` — `install | status | uninstall` (LaunchAgent /
  systemd timer).
- `prosa setup` — interactive first-run wizard.
- `prosa login` — re-authenticate (sub-step of setup).

Global flags:

- `--last`, `--since`, `--between`
- `--project`, `--device`, `--agent`
- `--all`
- `--remote`
- `--json`
- `--no-color`

Keep flags stable across cuts. Renaming or removing is a breaking change
and requires updating `docs/usage.md` in the same PR.

## Rendering rules

- Timeline, search, show, and analytics are one-shot renderers; no
  resident TUI.
- TTY output may use Lipgloss colors and responsive truncation per
  `docs/cli/rendering-contract.md`.
- Non-TTY output must be plain text or NDJSON without escape codes.
- `prosa sync` may use Bubble Tea progress in interactive terminals,
  with a plain structured fallback for cron/LaunchAgent/systemd use.
  See `docs/cli/motion.md` for the motion contract.
- Do not print logs to stdout when stdout is carrying command output.
  Logs go to stderr.

## Project scoping

When not using `--all`, read commands may auto-scope to the project
detected from cwd (git remote > `.prosa.yaml` marker > cwd fallback).
Make that scoping visible on stderr for human output and silent for
JSON/NDJSON output.

## Testing

CLI/rendering changes should cover both interactive and non-interactive
paths where practical:

- JSON/NDJSON output remains machine-readable.
- Plain output contains no ANSI escapes.
- Long titles/projects truncate without breaking alignment.
- Date headers and active-session markers stay consistent with the
  rendering contract.

Run `go test ./internal/cli/... -race` and `just test-race`.

## See also

- `docs/architecture/cli.md` — handler files, render pipeline, sync
  internals.
- `docs/cli/screens.md` — screen-by-screen mocks.
- `docs/cli/rendering-contract.md` — color tokens, truncation rules.
- `docs/cli/motion.md` — when motion is allowed and how it falls back.
