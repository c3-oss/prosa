# Lane 7 — v1-to-v2 command mapping

The new `prosa read *` command group replaces a handful of v1 commands
with receipt-pinned equivalents that consume the Lane 6 read API.
v1 commands stay registered alongside v2 through Lane 9 and only emit
a deprecation notice at Lane 10 cutover.

| v1 command                                                       | v2 equivalent                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `prosa sessions list`                                            | `prosa read sessions [filters]`                               |
| `prosa sessions count`                                           | `prosa read sessions --count [filters]`                       |
| `prosa session show <id> --format markdown`                      | `prosa read transcript <id> --format markdown`                |
| `prosa session show <id> --format text`                          | `prosa read transcript <id> --format text`                    |
| `prosa session show <id> --format json`                          | `prosa read transcript <id> --format json`                    |
| `prosa search <query>`                                           | `prosa read search <query>`                                   |
| `prosa query duckdb '<sql>'`                                     | `prosa read query '<sql>' --engine duckdb` (local-only)       |
| `prosa analytics sessions\|tools\|errors\|models\|projects`      | `prosa read analytics <report>`                               |
| `prosa export session <id> --format markdown`                    | `prosa read transcript <id> --format markdown --out <path>` * |
| `prosa export parquet`                                           | `prosa read export parquet` (local-only)                      |
| `prosa mcp serve`                                                | `prosa mcp serve --authority {auto\|local\|remote}` (Lane 7 slice 9) |
| `prosa tui`                                                      | `prosa tui` (unchanged; backed by the v2 read context)        |

\* The v2 `prosa read transcript` does not yet write to a file; pipe
its stdout when an output file is needed. A `--out` flag will be added
in a follow-up slice if operators continue using
`prosa export session` for file writes.

## Common options shared by every `prosa read *` command

- `--store <path>` — bundle directory.
- `--authority <mode>` — `auto` (default), `local`, or `remote`.
  - `auto`: routes to the remote read API when a v2 promotion is
    recorded for the store, otherwise reads the local bundle.
  - `local`: forces the local bundle even for promoted stores. The
    CLI prints no stale-data warning; the operator opted in.
  - `remote`: fails closed when no v2 promotion is recorded.
- `--refresh` — force an authority refresh (`GET /v2/stores/:storeId/authority`).
- `--offline` — use the cached authority and never hit the network.
- `--server <url>` — override the active server.
- `--config <path>` — override the CLI config path.

## Authority cache

Cached entries live at `<config>/authority/<storeId>.json` with mode
0600. The TTL is 60 s; within the window the resolver does not touch
the network. Outside the window (or with `--refresh`) the resolver
re-issues `GET /v2/stores/:storeId/authority` and rewrites the entry.

## Mid-command 412 handling

When the server returns HTTP 412 mid-command, the CLI raises
`AuthorityChangedError` with an explicit "rerun the command" message.
For paginated reads (`--all-pages`) this prevents mixing two
receipt snapshots in the same output. Idempotent single-page reads
can be retried by the operator with a fresh receipt cached.
