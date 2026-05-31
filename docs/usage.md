# Usage

The full command reference for the `prosa` CLI. For install, see
[install.md](install.md). For the server + panel deployment, see
[self-hosting.md](self-hosting.md).

## First-time setup

```sh
prosa setup
```

A short wizard:

1. Server URL (default `https://prosa.c3.do`; configurable).
2. Browser-based device auth (the wizard prints a one-time user code, opens
   the server's verification URL, and polls for approval).
3. Detection of local agent histories (`~/.claude/projects`,
   `~/.codex/sessions`, `~/.cursor/`, `~/.gemini/`).
4. Scheduled sync install (LaunchAgent on macOS, systemd user timer on
   Linux). Default interval: 15 minutes.
5. The first scan (opt-in; you can skip it and run `prosa sync` later).

Flags:

| Flag | Default | Notes |
| --- | --- | --- |
| `--server <URL>` | `$PROSA_SERVER_URL` or `https://prosa.c3.do` | The server to register with. |
| `--interval <duration>` | `15m` | How often the scheduled job runs. |
| `--skip-scan` | | Skip the first scan after setup. |
| `--non-interactive` | | Fail rather than prompt. Useful in scripts. |

If you only want re-authentication, use `prosa login` instead of the full
wizard.

## Daily flow

### Show the timeline

```sh
prosa                       # last 7 days, scoped to the current project if known
prosa --all                 # every project
prosa --last 30d            # broader window
prosa --last 12h --device laptop
```

Output is grouped by relative day (`Today`, `Yesterday`, `2 days ago`, …)
and shows for each session:

- start time (with `*` if the session is currently active),
- device,
- agent,
- project,
- the first user prompt (truncated to fit),
- duration,
- main tools used.

Inside a known project, prosa auto-scopes to that project; `--all` overrides.

### Search across turns

```sh
prosa search "sqlite FTS"
prosa search "deploy" --last 30d --project mz-iac
prosa search "deploy" --remote        # cross-device, via the server
```

Local search uses SQLite's FTS5 (porter + unicode61). `--remote` uses the
server's Postgres `tsvector` (simple tokenizer) — useful when you want to
search across machines.

### Read a session

```sh
prosa show <session-id>                          # rendered (TTY) / raw (pipe)
prosa show <session-id> --json                   # one JSON object
prosa show <session-id> --raw                    # preserved JSONL bytes
prosa show <session-id> --max-output-lines 20    # cap per-turn body
prosa show <session-id> --remote                 # fetch from prosa-server
```

In a TTY the default shows the structured human view — session
metadata then a `turns` section with chat lines and projected tool
results (rendered as `tool:<name>`). `--json` emits a single
`{session, tools, turns}` object. `--raw` (and any non-TTY pipe
without `--json`) emit the preserved JSONL bytes verbatim — the
agent's source is never altered.

### Sync

```sh
prosa sync                          # ad-hoc; same job the scheduler runs
prosa sync --verbose                # progress detail
```

In interactive mode `prosa sync` shows a Bubble Tea spinner with progress
per importer. In a pipe or under a cron-style scheduler it falls back to a
quiet, structured log.

### Analytics

```sh
prosa analytics sessions            # count by agent + total turns
prosa analytics tools               # top 20 tools across the window
prosa analytics models              # session distribution by model
prosa analytics projects            # top 30 projects
prosa analytics heatmap             # sessions per UTC day
prosa analytics usage               # token totals + estimated USD cost
prosa analytics errors              # sessions matching error heuristics
```

`--remote` runs the report against the server. All reports honor the global
filters below, including `--last`, `--since`, `--between`, `--project`,
`--agent`, `--device`, and `--all`.

### Devices (cross-device)

```sh
prosa devices list
prosa devices rename <id|self> <friendly-name>
prosa devices revoke <id|self>
```

The local store only knows about this machine; `prosa devices` always
queries the server.

### Schedule control

```sh
prosa schedule install --interval 15m
prosa schedule status
prosa schedule uninstall
```

On macOS this writes a LaunchAgent plist into
`~/Library/LaunchAgents/`. On Linux it writes a user systemd timer into
`~/.config/systemd/user/`.

## Global flags

Available across all commands (and as defaults for `prosa` with no
subcommand):

| Flag | Default | Notes |
| --- | --- | --- |
| `--last <duration>` | `7d` | Rolling window. Accepts `12h`, `7d`, `30d`, etc. |
| `--since <YYYY-MM-DD>` | | Anchored lower bound in UTC. |
| `--between <A..B>` | | Closed UTC range. Both ends `YYYY-MM-DD`, separated by `..`. |
| `--project <name>` | | Substring filter. Matches `project_path`, `project_remote`, or `project_marker` — so `--project movaincentivo` finds sessions captured under any of the three. |
| `--device <name>` | | Match `friendly_name` (cross-device only). |
| `--agent <name>` | | One of `claude-code`, `codex`, `cursor`, `gemini`. |
| `--all` | | Drop the auto cwd-based project scoping. |
| `--remote` | | Query the server instead of the local store. |
| `--json` | | NDJSON output, one record per line. |
| `--no-color` | | Suppress ANSI even on a TTY. |
| `--help` | | Per-command help. |

The bare `prosa` timeline also accepts `--limit N` to cap the number
of returned sessions (useful for agents that want a small sample).
`prosa search` has its own `--limit`; other subcommands don't take
one.

`--last`, `--since`, and `--between` are **mutually exclusive** — pick
one. Combining them surfaces an error before the store is touched.

`--json` writes machine-readable NDJSON to stdout. Human logs (project
scoping, progress messages) go to stderr so pipelines stay clean.

## Output modes

prosa renders for three audiences:

- **TTY (default in a terminal)** — styled tables, day headings, color with
  purpose. See [cli/rendering-contract.md](cli/rendering-contract.md) for
  the full token palette and truncation rules.
- **Plain** (when stdout is redirected) — no ANSI, no day grouping repeats,
  no spinners. Safe for cron, scripts, pagers.
- **JSON** (`--json`) — NDJSON, one session/result per line, stable schema
  per command.

Logs that aren't part of the command's primary output go to stderr —
including project scope hints ("scoped to prosa · use --all for every
project").

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PROSA_HOME` | `~/.local/share/prosa` | Data root (store + raw). |
| `PROSA_SERVER_URL` | `https://prosa.c3.do` | Server for `--remote` and sync. |
| `PROSA_CONFIG_HOME` | `~/.config/prosa` | Auth token + setup state. |
| `XDG_DATA_HOME` | | Honored for `PROSA_HOME` if set. |
| `XDG_CONFIG_HOME` | | Honored for `PROSA_CONFIG_HOME` if set. |
| `NO_COLOR` | | Standard. Forces plain output. |

## Examples

A few common one-liners:

```sh
# what did I do yesterday (rolling window)
prosa --last 1d

# what did I do across Q1 2026
prosa --between 2026-01-01..2026-03-31

# everything since the V3 release tag
prosa --since 2026-05-30

# all my SQLite work, regardless of device
prosa search "sqlite" --remote --last 90d

# everything I did on mz-iac with codex
prosa --all --project mz-iac --agent codex

# pipe to jq
prosa --last 30d --json | jq '[.[] | {agent, project, started_at}]'

# show the raw of the most recent session
prosa --last 1d --json \
  | head -1 | jq -r '.id' \
  | xargs prosa show
```

## Where this maps to code

- Command implementations: `internal/cli/*.go` (see
  [architecture/cli.md](architecture/cli.md)).
- Rendering: `internal/cli/render/` (see
  [cli/rendering-contract.md](cli/rendering-contract.md)).
- Importers: `internal/importers/<agent>/` (see
  [architecture/importers.md](architecture/importers.md)).
- Store: `internal/store/` (see
  [architecture/store.md](architecture/store.md)).
