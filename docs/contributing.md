# Contributing

For everyone who wants to change code in prosa. Before you start, read
[`../INTENT.md`](../INTENT.md) end-to-end. Almost every "should I…?"
question is answered there.

## Setup

prosa pins its toolchain via [`../devbox.json`](../devbox.json). Inside
`devbox shell` you get exact versions of:

- Go 1.26
- buf 1.70
- protobuf 34.1
- golangci-lint 2.12
- gofumpt 0.10
- sqlite 3.51
- gitleaks 8.28
- lychee 0.23
- markdownlint-cli2 0.21
- ripgrep 15.1
- just 1.51
- node 24
- pnpm 10.20

You don't need to install any of those by hand. The shell exports `GOBIN`
into the repo's `./bin/`, installs the Node tooling with pnpm, and installs
the Husky git hooks.

```sh
git clone https://github.com/c3-oss/prosa.git
cd prosa
devbox shell
just tools           # installs protoc plugins into ./bin
just build           # builds the three binaries
```

If you don't use devbox, you'll need the same tool versions installed
somewhere on `PATH`. The CI workflows use devbox; mirroring that is the
safe path.

## Day-to-day

The full recipe set is in [`../.justfile`](../.justfile). Highlights:

| Command | Notes |
| --- | --- |
| `just build` | `go build -o ./bin/ ./cmd/...` |
| `just run -- <args>` | builds then runs `./bin/prosa <args>` |
| `just test` | `go test ./...` |
| `just test-race` | `go test -race -count=1 ./...` |
| `just cover` | coverage profile + per-function summary |
| `just vet` | `go vet ./...` |
| `just lint` | `golangci-lint run ./...` |
| `just quality` | Markdown, link, agent-config, and secret checks |
| `just lint-md` | markdownlint over tracked Markdown |
| `just lint-links` | lychee over tracked Markdown links |
| `just lint-agents` | agnix over agent-facing config |
| `just lint-secrets` | gitleaks over the current tree |
| `just gen` | `buf lint` + `buf generate` + `gofumpt gen/` |
| `just gen-check` | regeneration must be no-op |
| `just tidy-check` | `go.mod`/`go.sum` must be tidy |
| `just ci` | full local pipeline + `git diff --exit-code` |
| `just snapshot` | local GoReleaser dry-run into `dist/` |
| `just docker-build` | local Docker image `prosa:local` |
| `just clean` | nukes `./bin`, `./dist`, coverage artifacts |

The repo has no Makefile. `just` is the canonical task runner — CI workflows
call it directly.

## Quality hooks

`devbox shell` installs Husky hooks through pnpm:

- `commit-msg` runs commitlint against `type(scope): subject`.
- `pre-commit` runs lint-staged Markdown checks, agnix, and staged gitleaks.
- `pre-push` runs `just hooks-pre-push`, currently the same non-Go gate as
  `just quality`.

CI also runs commitlint over pull-request commits and `just quality`.

## Conventions

These mirror INTENT § *How I think when I code*. They are not aspirational;
they are enforced by reviewers (human or agent).

- **Standard library first.** Reach for a dependency only when stdlib costs
  measurably more code than the dependency would save.
- **Error wrapping**: `fmt.Errorf("doing X: %w", err)`. No
  `pkg/errors`-style ladders.
- **Logging**: `log/slog` with the default text handler in CLI commands.
- **Filesystem paths** via `internal/paths` — never hardcode `~/...` or XDG
  layouts elsewhere.
- **Tests**: stdlib `testing` plus `github.com/stretchr/testify/require`.
  No mocking frameworks; if a layer is hard to test without mocks, its
  shape is wrong.
- **No premature abstraction.** Three call sites or it's not a helper. One
  call site stays inline.
- **No feature flags where a delete would do.**
- **Generated code** under `gen/` is committed; CI fails if regeneration
  produces a diff.

## Commit messages

The project follows `type(scope): subject` in the imperative. Commitlint
enforces the shape locally and in CI.

Examples:

```
feat(release): ESM shim with async spawn and signal forwarding
chore(tooling): standardize on Node.js 24 across release pipeline
docs(release): install paths (brew, curl, npm), setup mocks, intent update
build(deps): add nodejs@24
```

Scopes are defined in [`../commitlint.config.cjs`](../commitlint.config.cjs).
Use the smallest accepted scope that helps a future reader.

For large refactors, prefer **several smaller commits** grouped by category
of change over one mega-commit. Each commit should be reviewable on its own.

## Adding a new importer

Importers live in `internal/importers/<agent>/`. They implement the
interface in `pkg/importer/importer.go`:

```go
type Importer interface {
    Name() string
    DefaultRoots() []string
    Walk(ctx context.Context, root string) ([]string, error)
    Import(ctx context.Context, jsonlPath string, sink Sink) (ImportResult, error)
}
```

Steps:

1. **Read the canonical contract** —
   [architecture/canonical-session.md](architecture/canonical-session.md).
   Every importer maps onto the same `session.Session`,
   `session.Turn`, `session.ToolUsage` shape.
2. **Document the source format** — add `docs/sources/<agent>.md` that
   describes how the agent's JSONL is laid out on disk, where session IDs
   come from, how to detect first-prompt, model, project context.
3. **Implement the importer** in `internal/importers/<agent>/`. Look at
   `internal/importers/claudecode/` and `internal/importers/codex/` for
   shape. Keep the package small: one file per concern (`walk.go`,
   `parse.go`, `importer.go`, plus tests).
4. **Preserve the raw** — copy the source `.jsonl` byte-for-byte into the
   prosa data dir at `RawPath` (via `internal/paths.RawRoot(agent)`). Never
   alter source bytes; the hash must match what was on disk.
5. **Be idempotent** — short-circuit on hash match with the store's
   `LastHash`. Don't try to merge or diff turns.
6. **Write parser tests** under `internal/importers/<agent>/parse_test.go`
   covering: representative records, missing fields, malformed JSON,
   truncated files, sessions with no turns.
7. **Register it** in the sync command's importer list
   (`internal/cli/sync.go`).

Before opening a PR, run the importer reviewer agent locally — see
[agents.md](agents.md#specialist-agents) — or at minimum:

```sh
just test ./internal/importers/<agent>/... -race
just test ./internal/store/... -race
just test ./internal/cli/... -race
```

## Editing proto contracts

The proto source of truth is `proto/prosa/v1/*.proto`. Generated Go lives in
`gen/go/prosa/v1/` and is committed.

```sh
just gen          # regenerates after a proto edit
just gen-check    # CI uses this; must be a no-op
```

Schema versions are pathway-versioned (`v1`, `v2`, …). Breaking changes get
a new version directory, not an in-place edit.

## Editing docs

- If you change a public surface (CLI command/flag, proto, schema), update
  the matching `docs/` page in the same PR.
- Don't write documentation that the code doesn't yet support. If a feature
  is planned, put it in [`../ROADMAP.md`](../ROADMAP.md) instead.
- Don't duplicate INTENT in `docs/`. Link to it.
- Markdown rendered by GitHub. No site generator. Keep diagrams as ASCII or
  inline SVG.

## Releases

Releases are tag-driven (`v*` tags trigger GoReleaser + npm + Docker). The
maintainer runbook is in [distribution/release.md](distribution/release.md).

If you're not the maintainer cutting the release, you don't need to read
that.

## Working with AI agents on this repo

Project-specific subagents and skills live in `.codex/` and `.claude/`.
Their orientation is in [agents.md](agents.md). If you spawn an agent that
should follow project rules, point it at INTENT first.

## Where things live (cheat sheet)

| Lane | Read first | Code |
| --- | --- | --- |
| CLI commands | [architecture/cli.md](architecture/cli.md) | `internal/cli/` |
| CLI rendering | [cli/rendering-contract.md](cli/rendering-contract.md) | `internal/cli/render/` |
| Importers | [architecture/importers.md](architecture/importers.md), [sources/<agent>.md](sources/) | `internal/importers/<agent>/` |
| Local store | [architecture/store.md](architecture/store.md) | `internal/store/`, `migrations/local/` |
| Server | [architecture/server.md](architecture/server.md) | `internal/server/`, `migrations/server/` |
| Panel | [architecture/panel.md](architecture/panel.md), [panel/](panel/) | `internal/panel/`, `cmd/prosa-panel/` |
| Sync | [concepts.md#push-only-sync](concepts.md#push-only-sync) | `internal/cli/sync*.go` |
| Proto / API | [architecture/server.md](architecture/server.md) | `proto/prosa/v1/`, `gen/go/prosa/v1/` |
| Paths / XDG | (read the package) | `internal/paths/` |
| Distribution | [distribution/](distribution/) | `.goreleaser.yaml`, `install.sh`, `npm/`, `Dockerfile`, `.github/workflows/` |
