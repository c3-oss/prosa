# Agent guide — prosa v3

`INTENT.md` is the source of truth for product scope, architecture, schema,
and CLI surface. Read it before proposing changes. This file is the operating
guide for AI coding agents working in the repo.

## Project shape

Single Go module: `github.com/c3-oss/prosa`. Three binaries built from
`cmd/`: the CLI (`prosa`), the API server (`prosa-server`), and the web
panel (`prosa-panel`). Source layout follows INTENT.md §11.

| Path | Purpose |
|---|---|
| `cmd/<bin>/main.go` | thin entrypoints |
| `proto/prosa/v1/` | Protobuf source of truth |
| `gen/go/prosa/v1/` | Buf-generated Go (committed) |
| `pkg/` | exportable: `importer` interface, `session` domain types |
| `internal/cli/` | CLI commands, rendering, spinner |
| `internal/store/` | SQLite open/migrate/queries |
| `internal/importers/<agent>/` | per-agent implementations |
| `migrations/local/` | SQLite migrations (embedded via `embed.FS`) |
| `docs/` | architecture references, source-format specs |

## Commands

Run inside `devbox shell` so the pinned toolchain is on `$PATH`.

- `make tidy` — `go mod tidy`
- `make tools` — installs `protoc-gen-go` + `protoc-gen-connect-go` into `./bin`
- `make gen` — runs `buf generate` and formats `gen/`
- `make lint` — `golangci-lint run ./...`
- `make test` — `go test -race -count=1 ./...`
- `make build` — `go build -o ./bin/ ./cmd/...`
- `make ci` — full pipeline + `git diff --exit-code` (catches uncommitted regen)

## Conventions

- Standard library first. Reach for a dependency only when stdlib costs
  measurably more.
- Errors from `pkg/errors`-style wrapping are out; use `fmt.Errorf("...: %w", err)`.
- Logging is `log/slog` with the default text handler in CLI commands.
- Filesystem paths via `internal/paths` — never hard-code `~/...` or XDG layouts.
- Tests use stdlib `testing` plus `github.com/stretchr/testify/require` for
  assertions. No mocking frameworks.
- Commit messages keep the `type(scope): subject` convention from the v2
  history for continuity. Scopes are free-form (no enforced enum yet).
- Generated files (`gen/`) are committed; CI fails if regeneration produces
  a diff.

## Where to start

1. Read `INTENT.md` end-to-end.
2. Read `docs/canonical-session.md` for the JSONL → `session.Session` mapping
   that every importer must satisfy.
3. Read the relevant `docs/sources/<agent>.md` for the source format you are
   touching.
4. Find an analogous file in the same lane and follow its shape.

## What is intentionally not here

- DuckDB, Parquet, content-addressable storage — v2 carried these; v3 does not.
- Bidirectional sync, multi-tenancy, retention pipelines — push-only single-user
  is the target. See INTENT.md §3.
- Pre-commit hooks, lint-staged, commitlint enforcement, husky — v3 trusts CI.
