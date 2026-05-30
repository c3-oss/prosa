# Architecture

How the code is really structured today. Aspirational shapes belong in
[`../../INTENT.md`](../../INTENT.md); aspirational features belong in
[`../../ROADMAP.md`](../../ROADMAP.md). This tree describes the repo as
it is.

## Three binaries, one module

```
github.com/c3-oss/prosa
├── cmd/prosa            CLI (thin entrypoint)
├── cmd/prosa-server     API server (thin entrypoint)
├── cmd/prosa-panel      Web panel (thin entrypoint)
├── pkg/                 exportable (third parties may import)
│   ├── importer/        plugin interface
│   └── session/         domain types
├── internal/            private to the module
│   ├── cli/             CLI commands, rendering, spinner
│   ├── store/           SQLite (local store) — open, migrate, queries
│   ├── server/          Postgres + S3 + Connect handlers
│   ├── panel/           html/template + HTMX views
│   ├── importers/       per-agent implementations
│   ├── paths/           XDG-aware filesystem layout
│   └── ...
├── proto/prosa/v1/      Protobuf source of truth
├── gen/go/prosa/v1/     buf-generated Go (committed)
├── migrations/
│   ├── local/           SQLite migrations (embedded)
│   └── server/          Postgres migrations
└── ...
```

CLI and panel are **clients** of the server's Connect API. There is no
direct CLI ↔ panel communication. Each binary is independently deployable.

## Read order

| Lane | Doc |
| --- | --- |
| CLI internals — subcommands, flags, render pipeline | [cli.md](cli.md) |
| Server internals — HTTP, Connect, schema, S3 | [server.md](server.md) |
| Panel internals — templates, HTMX, OAuth, SSE | [panel.md](panel.md) |
| Importer plugin interface and contract | [importers.md](importers.md) |
| Local store — SQLite schema, FTS5, raw layout, sync_state | [store.md](store.md) |
| Canonical session contract (the type every importer maps to) | [canonical-session.md](canonical-session.md) |

For the *why* behind these shapes, see
[`../../INTENT.md`](../../INTENT.md). For the *what* you can do as a user,
see [`../usage.md`](../usage.md).

## Data flow at a glance

```
   ┌───────────┐  scan + parse + hash      ┌──────────────────────┐
   │   agent   │ ────────────────────────▶ │      prosa CLI       │
   │   JSONL   │                            │  (importer + store)  │
   └───────────┘                            └──────────┬───────────┘
                                                       │
                                              ┌────────┴────────┐
                                              │                  │
                                              ▼                  ▼
                                       ┌────────────┐    ┌───────────────┐
                                       │  SQLite    │    │  raw .jsonl   │
                                       │  + FTS5    │    │  on disk      │
                                       └─────┬──────┘    └───────┬───────┘
                                              │                  │
                                              │                  │
                                              ▼                  ▼
                                       ┌──────────────────────────────┐
                                       │     prosa sync (push)        │
                                       └──────────────┬───────────────┘
                                                      │  Connect RPC
                                                      ▼
                                          ┌─────────────────────┐
                                          │     prosa-server    │
                                          └─────┬───────────┬───┘
                                                │           │
                                                ▼           ▼
                                       ┌────────────┐  ┌─────────┐
                                       │  Postgres  │  │   S3    │
                                       │   + FTS    │  │  bucket │
                                       └─────┬──────┘  └─────────┘
                                              │
                                              ▼
                                       ┌──────────────┐
                                       │ prosa-panel  │  ◀── browser
                                       │ (html/HTMX)  │
                                       └──────────────┘
```

The local store is authoritative for what is on this device. The server is
authoritative for the cross-device view. Raw files are the source of truth
for content; the indexes are derivable.

## API contract

Proto in `proto/prosa/v1/`. Generated Go in `gen/go/prosa/v1/`, committed.
Connect-Go handlers in `internal/server/`, Connect clients in the CLI and
panel.

Services:

- **AuthService** — `StartLogin`, `PollLogin`, `ApproveLogin`, `Whoami`.
  Device-code OAuth flow.
- **SessionsService** — `Push`, `List`, `Get`, `Search`, `Manifest`,
  `GetRaw`.
- **DevicesService** — `List`, `Rename`, `Revoke`.
- **AnalyticsService** — `GetReport` (one of `sessions`, `tools`,
  `models`, `projects`, `errors`).
- **HealthService** — standard gRPC health check.

Schemas are versioned `v1`, `v2`, …. Breaking changes get a new directory,
never an in-place mutation. See [server.md](server.md) for handler details.

## Migrations

| Layer | Path | What's there |
| --- | --- | --- |
| Local (SQLite) | `migrations/local/` | `0001_init`, `0002_identity`, `0003_manifest_index` |
| Server (Postgres) | `migrations/server/` | `0001_init`, `0002_manifest_index`, `0003_turns_tsvector_cap`, `0004_session_notify` |

Both layers apply migrations at process startup. Migration files are
embedded via `embed.FS`; there is no separate migrate binary to run.

## Paths

`internal/paths/` is the only package that knows about XDG layout. Everything
else asks it for paths:

- `paths.Home()` — `$PROSA_HOME` or `$XDG_DATA_HOME/prosa` or
  `~/.local/share/prosa`.
- `paths.StorePath()` — `Home()/store.db`.
- `paths.RawRoot(agent)` — `Home()/raw/<agent>/`.
- `paths.ConfigHome()` — `$PROSA_CONFIG_HOME` or `$XDG_CONFIG_HOME/prosa`
  or `~/.config/prosa`.
- `paths.AuthPath()` — `ConfigHome()/auth.json`.

If you find a hardcoded path elsewhere, that is a bug.

## Toolchain

Pinned via `devbox.json`:

- Go 1.26, buf 1.70, protobuf 34.1, golangci-lint 2.12, gofumpt 0.10
- sqlite 3.51, ripgrep 15.1, just 1.51, node 24

Inside `devbox shell`, `GOBIN=./bin` is exported. `just build` produces
the three binaries into `./bin/`. CI uses devbox too — mirroring it is the
safe path locally.

## What lives where (quick map)

| What you want to change | File / directory |
| --- | --- |
| CLI subcommand | `internal/cli/<command>.go` |
| CLI rendering token / color | `internal/cli/render/` |
| Importer for an agent | `internal/importers/<agent>/` |
| Domain types | `pkg/session/types.go` |
| Importer interface | `pkg/importer/importer.go` |
| Local store query | `internal/store/<area>.go` |
| Local migration | `migrations/local/<n>_*.sql` |
| Server Connect handler | `internal/server/<service>.go` |
| Server migration | `migrations/server/<n>_*.sql` |
| Panel template | `internal/panel/templates/<name>.html` |
| Panel route | `internal/panel/server.go` |
| Panel static asset | `internal/panel/templates/assets/` |
| Proto schema | `proto/prosa/v1/<service>.proto` |
| Build recipe | `.justfile` |
| Release pipeline | `.goreleaser.yaml`, `.github/workflows/release.yml` |

Everything else is glue. If you can't place a change on this map, that is
usually a sign it belongs on the map differently than where you started.
