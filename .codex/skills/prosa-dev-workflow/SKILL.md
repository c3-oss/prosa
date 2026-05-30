---
name: prosa-dev-workflow
description: Local development workflow for the prosa repository. Use when orienting in the codebase, choosing validation commands, or changing project-level tooling.
---

# Prosa Dev Workflow

Use this skill for repository orientation, command selection, and everyday
implementation hygiene.

## Module shape

Single Go module: `github.com/c3-oss/prosa`. Three binaries are built from
`cmd/`:

- `cmd/prosa` — local CLI.
- `cmd/prosa-server` — future Connect API server; stub in the current cut.
- `cmd/prosa-panel` — future web panel; stub in the current cut.

Core paths:

- `proto/prosa/v1/` — protobuf source of truth.
- `gen/go/prosa/v1/` — Buf-generated Go, committed.
- `pkg/importer/` and `pkg/session/` — exportable importer and domain types.
- `internal/importers/<agent>/` — Claude Code and Codex importers.
- `internal/store/` — SQLite local store, migrations, FTS5 queries.
- `internal/cli/` — Cobra command tree, rendering, sync, search, show.
- `docs/` — canonical session and source-format references.

Read `INTENT.md` before changing scope or architecture.

## Command surface

Standard workflow via `.justfile`:

```bash
just build          # builds prosa, prosa-server, prosa-panel into bin/
just run ...        # builds, then runs bin/prosa with args
just test           # go test ./...
just test-race      # go test -race -count=1 ./...
just cover          # coverage profile + per-function totals
just vet            # go vet ./...
just lint           # golangci-lint run ./...
just tools          # installs protoc generators into ./bin
just gen            # buf lint + buf generate + gofumpt gen/
just gen-check      # generation must not produce a diff
just tidy-check     # go.mod/go.sum must already be tidy
just ci             # full local validation lane
just snapshot       # GoReleaser snapshot build; requires goreleaser on PATH
just docker-build   # local Docker image
```

The Makefile remains available for compatibility.

## Validation lanes

Smallest useful check first:

- Small package change: `just test`.
- Importer change: focused `go test ./internal/importers/<agent>/...` plus
  `just test-race`.
- Store/search change: `go test ./internal/store/... -race`.
- Proto change: `just gen`, inspect `gen/`, then `just gen-check`.
- Project tooling/release change: `just ci`; when GoReleaser or Docker changes,
  also run `just snapshot` and `docker build -t prosa:local .`.

## Implementation rules

- Preserve `INTENT.md`: SQLite local, Postgres/S3 later, push-only sync,
  single-user, no DuckDB/Parquet/CAS.
- Use standard library first; add dependencies only when they clearly reduce
  real implementation cost.
- Wrap errors with `fmt.Errorf("context: %w", err)`.
- Filesystem paths go through `internal/paths`; do not hard-code home/XDG paths.
- Generated files under `gen/` are committed and must be regenerated in the
  same change as `proto/`.
- Tests use stdlib `testing` plus `testify/require`; no mocking frameworks.

## Commit hygiene

- Conventional commits with focused scopes, e.g. `feat(importer): ...`,
  `chore(release): ...`, `docs(readme): ...`.
- Keep generated-code diffs with the proto change that caused them.
- CI runs on PR/push to `master`; tags `v*` trigger release.
