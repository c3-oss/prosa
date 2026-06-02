# Architecture: CLI

How the `prosa` CLI is structured internally. For the user-facing command
reference see [`../usage.md`](../usage.md). For the visual design of CLI
output see [`../cli/`](../cli/).

## Entry point

`cmd/prosa/main.go` is one-screen thin. It delegates to
`internal/cli.Execute()`, which builds the Cobra command tree, parses
flags, and dispatches.

```
cmd/prosa/main.go               thin entrypoint
└─ internal/cli/root.go         cobra root + global flags + subcommand registration
   ├─ internal/cli/<command>.go  per-command file
   └─ internal/cli/render/       rendering primitives shared across commands
```

The CLI never imports `internal/server` or `internal/panel`. The boundary
is the Connect-Go client in `internal/cli` that talks to `prosa-server`.

## Subcommands

| Command | Handler file | Notes |
| --- | --- | --- |
| `prosa` (bare) | `internal/cli/nu.go` | Default timeline view |
| `prosa sync` | `internal/cli/sync.go` (+ `sync_push.go`, `sync_reconcile.go`, `sync_denoise.go`) | Import + push, idempotent by hash |
| `prosa search` | `internal/cli/search.go` | Local FTS5 (default) or server FTS (`--remote`) |
| `prosa show` | `internal/cli/show.go` | Print preserved raw JSONL |
| `prosa analytics` | `internal/cli/analytics.go` | Fixed reports, including heatmap and usage. The heatmap report has a fixed trailing 53-week window and rejects `--last/--since/--between`. |
| `prosa login` | `internal/cli/login.go` | PKCE browser auth |
| `prosa devices …` | `internal/cli/devices.go` | `list`, `rename`, `revoke` |
| `prosa schedule …` | `internal/cli/schedule_cmd.go` + `internal/cli/schedule/` | `install`, `status`, `uninstall` |
| `prosa setup` | `internal/cli/setup.go` | Wizard wrapping login + schedule + first sync |

Each handler:

1. Reads relevant global flags from the cobra context.
2. Opens the local store (`store.Open(ctx, paths.StorePath())`) when needed.
3. Calls the appropriate store function or Connect client.
4. Hands the result to a renderer in `internal/cli/render/`.
5. Returns. The renderer is responsible for choosing TTY / plain / JSON.

## Global flags

Registered on the cobra root in `internal/cli/root.go`:

- `--last <duration>` (default `7d`)
- `--since <date>`
- `--between <A..B>`
- `--project <name>`
- `--device <name>`
- `--agent <name>`
- `--all`
- `--remote`
- `--json`
- `--no-color`

`--last`, `--since`, `--between` are mutually exclusive and parsed by
`internal/cli/window.go` (`ResolveWindow`) into a `SessionFilter.Since/Until`
pair plus a label that drives the context line. The filter is then threaded
through either the local store or the Connect client.

## Output modes

Three audiences, picked once per command and threaded through the renderer:

- **TTY** — `os.Stdout` is a terminal. Use Lipgloss styling, colors, day
  headings. See [`../cli/rendering-contract.md`](../cli/rendering-contract.md).
- **Plain** — `os.Stdout` is not a terminal. No ANSI, no day-header
  repeats, no spinners.
- **JSON** (`--json`) — NDJSON, one record per line. Stable schema per
  command; documented inline in the command's handler.

Human-facing logs (project scoping hints, progress) always go to stderr.
`stdout` carries only the command's primary result, so pipelines and
scripts stay clean.

## Rendering

`internal/cli/render/` provides:

- **timeline.go / timeline_test.go** — the default `prosa` view, day-grouped.
- **search.go** — search hit rendering with snippet highlighting.
- **device.go**, **prompt.go**, **cardinality.go**, **analytics.go** — small
  shared helpers for the various tabular outputs.

Renderers do not call Cobra, do not touch the filesystem, and do not open
the store. They take typed inputs and produce output strings or stream
bytes. This keeps them testable and keeps each command file small.

## Long-running commands

`prosa sync` is the only command that uses Bubble Tea. The pattern:

- **Interactive TTY**: a spinner with per-importer progress lines, updated
  in place.
- **Non-interactive (cron, systemd, pipe)**: structured slog text. No
  spinner, no in-place updates. The scheduler invokes prosa this way, so
  this is the default for the production install.

The fallback decision lives in `internal/cli/sync.go` and looks at whether
`stderr` is a TTY (not stdout — sync writes its summary to stdout).

## Store access

The CLI opens the local store via `store.Open(ctx, paths.StorePath())`. The
store pragmas (WAL, foreign keys ON, synchronous NORMAL) are set in
`internal/store/store.go`. Migrations run automatically on open; embedded
SQL files in `migrations/local/` are applied in order.

Each query funnels into a small set of functions:

| Function | Used by |
| --- | --- |
| `ListSessions(ctx, SessionFilter)` | `nu`, parts of `analytics`, JSON output |
| `Search(ctx, query, SessionFilter, limit)` | `search` |
| `GetSession`, `GetTurns`, `GetSessionTools` | `show`, panel-side reads |
| `UpsertSession`, `InsertTurns`, `LastHash`, `RecordSync` | `sync` |
| `ListDevicesMap` | timeline column resolution |
| `Analytics*` | `analytics` |
| `RebindLocalSessions` | one-time migration helper during `setup` |

The CLI never builds SQL by hand. If a query doesn't exist, add a function
in `internal/store/<area>.go` first.

## Connect client

`internal/cli/rpc/client.go` wraps the generated Connect clients
in `gen/go/prosa/v1/`. The client:

- Reads the server URL from `auth.json` (or `--server`, or
  `PROSA_SERVER_URL`).
- Reads the bearer token from `auth.json`.
- Attaches it as `Authorization: Bearer <token>` on every call.
- Builds Connect-Go RPC clients for `AuthService`, `SessionsService`,
  `DevicesService`, `AnalyticsService`.

`--remote` swaps the underlying data source from `*store.Store` to the
Connect client. The render layer doesn't care.

## Sync internals

```
sync.go              top-level orchestration, importer loop, progress callback
sync_push.go         per-session push to the server
sync_reconcile.go    server manifest comparison + missing-session push
sync_denoise.go      backfill / repair helpers (e.g. fix first_prompt)
schedule_cmd.go      schedule install/uninstall/status subcommands
schedule/            platform-specific install (launchd / systemd user timer)
```

The push side is documented in
[`../concepts.md#push-only-sync`](../concepts.md#push-only-sync).

The schedule install writes a LaunchAgent plist or systemd user unit that
invokes `prosa sync` at a fixed interval (default 15 min). It does not run
the sync command itself.

## Testing the CLI

- **Render layer**: golden-style tests next to the renderer
  (`internal/cli/render/timeline_test.go` is the model). Cover both TTY and
  plain output, and JSON shape.
- **Sync**: use a temp store + an in-memory Sink to test importer behavior.
  See `internal/importers/claudecode/parse_test.go` for the pattern.
- **Commands**: prefer testing the function the handler calls, not the
  Cobra wiring. Cobra-level tests rarely earn their keep here.

The default validation lane for CLI changes is:

```sh
just test ./internal/cli/... -race
```

A broader sweep: `just test-race` (full suite, race detector).

## When changing the CLI

If you touch the public surface (new subcommand, new flag, renamed flag,
changed output shape):

1. Update [`../usage.md`](../usage.md) in the same change.
2. Update the relevant `internal/cli/render/*_test.go` golden output if the
   render changed.
3. If a flag changed name or semantics, search the repo for any docs/agent
   referencing it.
4. Run the `prosa-cli-ux-reviewer` agent (or do its checks manually): TTY
   readable, plain ANSI-free, JSON parseable, project scoping on stderr,
   Bubble Tea has the cron-safe fallback.

The full lane to run before opening a PR:

```sh
just ci
```
