[![CI][ci-shield]][ci-url]
[![Release][rel-shield]][rel-url]
[![GitHub tag][tag-shield]][tag-url]

# `prosa`

> Unified AI-agent session history for answering one question quickly:
> "what did I work on in the last N days?"

`prosa` consolidates Claude Code, Codex, and future agent sessions into a
queryable work history. The v3 rewrite keeps the core deliberately small:
import local JSONL, preserve raw files, index metadata and turns in SQLite,
and render a fast terminal timeline. The server and web panel are staged as
the next MVP cuts.

[ci-shield]: https://img.shields.io/github/actions/workflow/status/c3-oss/prosa/ci.yml?label=ci&logo=github&style=flat-square
[ci-url]: https://github.com/c3-oss/prosa/actions/workflows/ci.yml
[rel-shield]: https://img.shields.io/github/actions/workflow/status/c3-oss/prosa/release.yml?label=release&logo=github&style=flat-square
[rel-url]: https://github.com/c3-oss/prosa/actions/workflows/release.yml
[tag-shield]: https://img.shields.io/github/tag/c3-oss/prosa.svg?logo=git&logoColor=FFF&style=flat-square
[tag-url]: https://github.com/c3-oss/prosa/releases

## Status

Go v3 rewrite. The current cut covers the local flow: Claude Code and Codex
importers, SQLite store, preserved raw JSONL, timeline rendering, FTS5 search,
and raw drill-down with `show`. `prosa-server` and `prosa-panel` compile as
stubs so the three-binary contract from [`INTENT.md`](INTENT.md) stays honest.

Not in this cut yet: remote sync, Postgres/S3 storage, login, scheduler, HTMX
panel, Homebrew tap, and `install.sh`.

## Build

```sh
devbox shell           # Go, buf, golangci-lint, gofumpt, just
just tools             # install protoc plugins into ./bin
just build             # builds ./bin/prosa, ./bin/prosa-server, ./bin/prosa-panel
./bin/prosa --version
```

Full local pipeline:

```sh
just ci                # tidy + gen + vet + lint + race tests + build + diff check
```

The `Makefile` remains available for compatibility, but `just` is the
recommended day-to-day interface.

### Docker

```sh
docker run --rm ghcr.io/c3-oss/prosa:latest
```

The image contains all three binaries and uses `prosa-server` as its default
entrypoint. To run the CLI inside the image:

```sh
docker run --rm --entrypoint prosa ghcr.io/c3-oss/prosa:latest --help
```

## Quick Start

```sh
just build
./bin/prosa sync                    # import local Claude Code/Codex sessions
./bin/prosa                         # timeline for the last 7 days
./bin/prosa --last 30d --all        # global timeline for the last 30 days
./bin/prosa search "sqlite FTS"      # full-text search over turns
./bin/prosa show <session-id>        # print preserved raw JSONL
```

By default, the SQLite store lives at `~/.local/share/prosa/store.db` and raw
files live under `~/.local/share/prosa/raw/...`. Set `PROSA_HOME` to use a
different data directory.

## Commands

| Command | Purpose |
|---|---|
| `prosa` | Render the local timeline. Default: last 7 days, auto-scoped to the current project when possible. |
| `prosa sync` | Scan known agent roots, import new or changed sessions, and preserve raw JSONL. |
| `prosa search <query>` | Search turn content through SQLite FTS5. |
| `prosa show <session-id>` | Copy the preserved raw JSONL for a session to stdout. |
| `prosa-server` | Stub for the future Connect/Postgres/S3 server. |
| `prosa-panel` | Stub for the future templ/HTMX web panel. |

### Global Flags

| Flag | Meaning |
|---|---|
| `--last` | Time window (`7d`, `30d`, `12h`). |
| `--project` | Filter by project using textual match. |
| `--device` | Filter by device friendly name. |
| `--agent` | Filter by agent (`claude-code` or `codex`). |
| `--all` | Disable cwd-based project auto-scoping. |
| `--json` | Emit NDJSON where the command supports it. |

## Architecture

```
cmd/prosa             -> local CLI: import, timeline, search, show
cmd/prosa-server      -> future Connect server; stub in the current cut
cmd/prosa-panel       -> future web panel; stub in the current cut
proto/prosa/v1        -> protobuf contracts, source of truth
gen/go/prosa/v1       -> Buf-generated Go, committed
pkg/importer          -> public importer interface
pkg/session           -> canonical session domain types
internal/importers    -> Claude Code and Codex implementations
internal/store        -> SQLite, migrations, sessions, turns, FTS5
internal/cli          -> Cobra, rendering, search, sync, spinner
internal/paths        -> XDG/PROSA_HOME path resolution
migrations/local      -> embedded SQLite migrations
docs/sources          -> agent source-format references
```

`docs/canonical-session.md` defines the JSONL -> `session.Session` contract
that every importer must satisfy. `INTENT.md` is the source of truth for
product scope, architecture, and future CLI/API shape.

## Tests

```sh
just test             # go test ./...
just test-race        # full suite with the race detector
just cover            # coverage profile + per-function totals
just lint             # golangci-lint
just gen-check        # buf generate must not change gen/
```

Before opening a PR:

```sh
just ci
```

Changes under `proto/` must regenerate and commit `gen/` in the same change.
Importer changes should include fixtures or tests covering the touched source
format.

## Release

Tags matching `v*` trigger the release workflow:

- GoReleaser publishes tarballs for macOS/Linux on `amd64` and `arm64`.
- SHA256 checksums are published as `checksums.txt`.
- A multi-arch Docker image is pushed to `ghcr.io/c3-oss/prosa`.

Local packaging checks:

```sh
just snapshot         # requires goreleaser on PATH
docker build -t prosa:local .
```

## License

To the extent possible under law, this project is dedicated to the public
domain under [CC0 1.0 Universal](LICENSE).
