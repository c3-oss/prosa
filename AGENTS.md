# Agent guide — prosa

This file is the operating guide for AI coding agents working in the prosa
repo. The product direction, scope, and trade-offs live in
[`INTENT.md`](INTENT.md) — **read that first** before proposing anything
substantial. The full agent orientation (decision checklists, where each
specialist agent lives, how to avoid bloat) lives in
[`docs/agents.md`](docs/agents.md).

## Read INTENT first

Before you propose a feature, a refactor, a dependency, or a doc edit, you
must be able to answer:

1. Does this make the central question (*"what did I work on in the last N
   days?"* — and the natural follow-ups around it) easier to answer?
2. Does it preserve everything in INTENT § **In scope (MVP)**?
3. Does it touch anything in INTENT § **Out of scope, intentionally**? If
   yes, you owe an explicit reason.
4. Does it fit INTENT § **How I think when I code**?

If you can't answer those, stop and read INTENT.

## Project shape

Single Go module: `github.com/c3-oss/prosa`. Three binaries built from `cmd/`:
the CLI (`prosa`), the API server (`prosa-server`), and the web panel
(`prosa-panel`). CLI and panel are clients of the server's Connect API; CLI
and panel never talk to each other directly.

| Path | Purpose |
| --- | --- |
| `cmd/<bin>/main.go` | thin entrypoints |
| `proto/prosa/v1/` | Protobuf source of truth |
| `gen/go/prosa/v1/` | Buf-generated Go (committed) |
| `pkg/importer/` | exportable plugin interface |
| `pkg/session/` | exportable domain types |
| `internal/cli/` | CLI commands, rendering, spinner |
| `internal/store/` | SQLite open/migrate/queries |
| `internal/server/` | Postgres + S3 + Connect handlers |
| `internal/panel/` | `html/template` + HTMX views |
| `internal/importers/<agent>/` | per-agent implementations |
| `internal/paths/` | XDG-aware filesystem layout |
| `migrations/local/` | SQLite migrations (embedded via `embed.FS`) |
| `migrations/server/` | Postgres migrations |

Deeper structure: [`docs/architecture/`](docs/architecture/).

## Commands

The toolchain is pinned via `devbox.json`. Inside `devbox shell`, everything
goes through `just` (the project's task runner). There is no Makefile.

- `just build` — builds `prosa`, `prosa-server`, `prosa-panel` into `./bin/`
- `just run -- <args>` — builds, then runs `./bin/prosa <args>`
- `just test` — `go test ./...`
- `just test-race` — `go test -race -count=1 ./...`
- `just cover` — coverage profile + per-function totals
- `just vet` — `go vet ./...`
- `just lint` — `golangci-lint run ./...`
- `just quality` — docs, links, agent config, and secret scanning
- `just lint-md` — markdownlint over tracked Markdown
- `just lint-links` — lychee over tracked Markdown links
- `just lint-agents` — agnix over agent-facing config
- `just lint-secrets` — gitleaks over the current tree
- `just tools` — installs `protoc-gen-go` + `protoc-gen-connect-go` into `./bin`
- `just gen` — `buf lint` + `buf generate` + `gofumpt gen/`
- `just gen-check` — regeneration must not produce a diff
- `just tidy-check` — `go.mod`/`go.sum` must already be tidy
- `just ci` — full local pipeline + `git diff --exit-code`
- `just snapshot` — GoReleaser snapshot build into `dist/`
- `just docker-build` — local Docker image `prosa:local`

## Conventions

- **Standard library first.** Reach for a dependency only when stdlib costs
  measurably more.
- **Error wrapping** with `fmt.Errorf("...: %w", err)`. No `pkg/errors`-style
  ladders.
- **Logging** is `log/slog` with the default text handler in CLI commands.
- **Filesystem paths** via `internal/paths` — never hardcode `~/...` or XDG
  layouts in other packages.
- **Tests** use stdlib `testing` plus `github.com/stretchr/testify/require`.
  No mocking frameworks.
- **Commit messages** keep the `type(scope): subject` convention from the v2
  history for continuity. Scopes are free-form and commitlint enforces the
  shape locally and in CI.
- **Git hooks** are managed by Husky and installed by `devbox shell`; they run
  commitlint, lint-staged Markdown checks, agnix, gitleaks, and the pre-push
  quality gate.
- **Generated files** (`gen/`) are committed; CI fails if regeneration
  produces a diff.

## Where to start

1. Read [`INTENT.md`](INTENT.md) end-to-end.
2. Skim [`docs/architecture/README.md`](docs/architecture/README.md) for the
   real shape of the code.
3. Read the relevant lane:
   - Importers → [`docs/architecture/importers.md`](docs/architecture/importers.md)
     plus [`docs/sources/<agent>.md`](docs/sources/).
   - CLI → [`docs/architecture/cli.md`](docs/architecture/cli.md) plus
     [`docs/cli/`](docs/cli/).
   - Server → [`docs/architecture/server.md`](docs/architecture/server.md).
   - Panel → [`docs/architecture/panel.md`](docs/architecture/panel.md) plus
     [`docs/panel/`](docs/panel/).
   - Store → [`docs/architecture/store.md`](docs/architecture/store.md).
   - Release / distribution → [`docs/distribution/`](docs/distribution/).
4. Find an analogous file in the same lane and follow its shape.
5. For decision support, see [`docs/agents.md`](docs/agents.md).

## What is intentionally not here

INTENT § **Out of scope, intentionally** is the source of truth. Highlights:

- No DuckDB / Parquet / columnar sidecars.
- No bidirectional sync — push-only stays push-only.
- No multi-user / multi-tenant in the MVP (post-MVP direction; no hooks
  pre-baked).
- No redaction at upload time.
- No automatic retention / pruning.

Developer hooks are intentionally present now as repo-local quality guardrails.
Adding new runtime scope is still a product decision that requires reading
INTENT and updating it.

## Specialist agents and skills

- `.codex/agents/` and `.claude/agents/` — specialist subagents
  (`prosa-architect`, `prosa-cli-ux-reviewer`, `prosa-importer-reviewer`,
  `prosa-test-runner`, `prosa-panel-ui-reviewer`, `prosa-docs-reviewer`).
- `.codex/skills/` — reusable skills (CLI rendering, dev workflow, importer
  session, panel rendering).
- `.codex/prompts/` — task-shaped prompts (importer change, release check).
- `.claude/settings.json` — Claude Code project settings.

When and how to invoke each is in [`docs/agents.md`](docs/agents.md).
