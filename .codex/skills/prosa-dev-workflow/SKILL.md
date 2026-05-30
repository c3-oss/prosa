---
name: prosa-dev-workflow
description: Local development workflow for the prosa repository. Use when orienting in the codebase, choosing validation commands, or changing project-level tooling.
---

# Prosa Dev Workflow

Use this skill for repository orientation, command selection, and
everyday implementation hygiene.

## Module shape

Single Go module: `github.com/c3-oss/prosa`. Three binaries built from
`cmd/`:

- `cmd/prosa` — local CLI.
- `cmd/prosa-server` — Connect API server (Postgres + S3-compatible).
- `cmd/prosa-panel` — server-rendered web panel (html/template + HTMX).

Core paths:

- `proto/prosa/v1/` — protobuf source of truth.
- `gen/go/prosa/v1/` — Buf-generated Go, committed.
- `pkg/importer/` and `pkg/session/` — exportable plugin interface and
  domain types.
- `internal/importers/<agent>/` — Claude Code, Codex, Cursor, Gemini
  importers.
- `internal/store/` — SQLite local store, migrations, FTS5 queries.
- `internal/cli/` — Cobra command tree, rendering, sync, search, show.
- `internal/server/` — Connect handlers, Postgres + S3 wiring.
- `internal/panel/` — html/template + HTMX views.
- `internal/paths/` — XDG-aware filesystem layout (the only package that
  knows where data lives).
- `docs/` — operational manual (architecture, source formats, design
  briefs, distribution).

Read `INTENT.md` end-to-end before changing scope or architecture. For
the real shape of the code, start at
`docs/architecture/README.md`.

## Command surface

Standard workflow via `.justfile`. There is no Makefile.

```bash
just build          # builds prosa, prosa-server, prosa-panel into ./bin
just run -- ...     # builds, then runs ./bin/prosa with args
just test           # go test ./...
just test-race      # go test -race -count=1 ./...
just cover          # coverage profile + per-function totals
just vet            # go vet ./...
just lint           # golangci-lint run ./...
just tools          # installs protoc generators into ./bin
just gen            # buf lint + buf generate + gofumpt gen/
just gen-check      # regeneration must not produce a diff
just tidy-check     # go.mod/go.sum must already be tidy
just ci             # full local validation lane
just snapshot       # GoReleaser snapshot build; requires goreleaser on PATH
just docker-build   # local Docker image (prosa:local)
just clean          # remove ./bin, ./dist, coverage artifacts
```

## Validation lanes

Smallest useful check first:

- Small package change: `just test`.
- Importer change: focused `go test ./internal/importers/<agent>/...
  -race` plus `just test-race`.
- Store/search change: `go test ./internal/store/... -race`.
- Server change: `go test ./internal/server/... -race`.
- Panel change: `go test ./internal/panel/... -race`.
- Proto change: `just gen`, inspect `gen/`, then `just gen-check`.
- Project tooling/release change: `just ci`; when GoReleaser or Docker
  changes, also `just snapshot` and `docker build -t prosa:local .`.

## Implementation rules

- Preserve `INTENT.md`: SQLite local, Postgres/S3 remote, push-only sync,
  single-user (MVP), no DuckDB/Parquet/columnar sidecars, no multi-tenant
  (post-MVP direction; no pre-baked hooks).
- Use the standard library first; add dependencies only when they
  measurably reduce the implementation cost.
- Wrap errors with `fmt.Errorf("context: %w", err)`. No
  `pkg/errors`-style ladders.
- Filesystem paths go through `internal/paths`; do not hardcode home/XDG
  layouts elsewhere.
- Generated files under `gen/` are committed and must be regenerated in
  the same change as `proto/`. Never edit them by hand.
- Tests use stdlib `testing` plus `testify/require`. No mocking
  frameworks.
- Logging is `log/slog` with the default text handler in CLI commands.

## Commit hygiene

- Conventional commits with focused scopes, e.g. `feat(importer): …`,
  `chore(release): …`, `docs(readme): …`.
- Keep generated-code diffs with the proto change that caused them.
- For large refactors, several smaller commits grouped by category beat
  one mega-commit.
- CI runs on PR/push to `master`; tags `v*` trigger release.

## When in doubt

`docs/agents.md` has the decision checklist and per-area starting points.
`docs/contributing.md` has the day-to-day conventions in narrative form.
