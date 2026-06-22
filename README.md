[![CI][ci-shield]][ci-url]
[![Release][rel-shield]][rel-url]
[![GitHub tag][tag-shield]][tag-url]

# `prosa`

> a work log for AI-agent sessions

> **prosa** /ˈpɾɔ.zɐ/ &nbsp;*noun*
> A conversation, a chat, an informal exchange of ideas.
> Prosa lets you have a conversation with your own work history.

`prosa` turns scattered Claude Code, Codex, Cursor, Gemini, and Antigravity
session histories into one local, searchable timeline. It is built around a
single load-bearing question:

> **What did I work on in the last N days?**

— and the natural follow-ups around it: where, on which projects, with which
agents and models, using which tools, taking how long, costing roughly what.

[ci-shield]: https://img.shields.io/github/actions/workflow/status/c3-oss/prosa/ci.yml?label=ci&logo=github&style=flat-square
[ci-url]: https://github.com/c3-oss/prosa/actions/workflows/ci.yml
[rel-shield]: https://img.shields.io/github/actions/workflow/status/c3-oss/prosa/release.yml?label=release&logo=github&style=flat-square
[rel-url]: https://github.com/c3-oss/prosa/actions/workflows/release.yml
[tag-shield]: https://img.shields.io/github/tag/c3-oss/prosa.svg?logo=git&logoColor=FFF&style=flat-square
[tag-url]: https://github.com/c3-oss/prosa/releases


## What prosa is — and isn't

prosa is a local-first, offline-friendly work log. Three small Go binaries
share one module and one typed contract:

- **`prosa`** — the CLI you actually use. Reads the local store by default.
- **`prosa-server`** — a thin personal API server (Postgres + S3-compatible
  object storage) for the cross-device view.
- **`prosa-panel`** — a server-rendered web panel that talks to the server.

It is **not** a chat manager, a residential TUI, an analytics warehouse, or a
multi-user SaaS. The shape and the boundaries live in [`INTENT.md`](INTENT.md);
read that file before proposing anything substantial.


## Install

```sh
# macOS — Homebrew tap (auto-published on every release)
brew install c3-oss/prosa/prosa
prosa setup

# Linux + macOS — POSIX install.sh with sha256 verification
curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh
prosa setup

# Anywhere with Node.js 22+ — npm picks the right platform binary
npm install -g @c3-oss/prosa
prosa setup
```

`prosa setup` is a short wizard: device auth, agent discovery, scheduled-sync
install (LaunchAgent on macOS, systemd user timer on Linux), and the first
scan. You can also drive it manually — see [`docs/install.md`][docs-install]
for the full matrix (including `PROSA_VERSION`, `INSTALL_DIR`, and
`INSTALL_BINS` for `install.sh`).


## First timeline

```text
Today
  11:24  laptop   claude-code   prosa       "refactor sync logic"
         -> 32min

  09:02* laptop   codex         mz-iac      "setup terraform module"
         -> 18min

Yesterday
  23:55  laptop   claude-code   prosa       "intent doc"
         -> 1h12
```

By default `prosa` reads the local store, scopes to the current project when
it can detect one, and shows the last 7 days. `--all` lifts the scope.


## Commands

| Command                              | What it does                                       |
| ------------------------------------ | -------------------------------------------------- |
| `prosa`                              | Timeline (auto-scoped when inside a known project) |
| `prosa --all`                        | Timeline across every project                      |
| `prosa sync`                         | Import local agent sessions, push to the server    |
| `prosa search <query>`               | Full-text search across turns (FTS5 local)         |
| `prosa show <session-id>`            | Print the preserved raw JSONL                      |
| `prosa analytics <report>`           | Fixed reports: `sessions`/`tools`/`errors`/`models`/`projects` |
| `prosa devices list \| rename \| revoke` | Manage known machines (cross-device)             |
| `prosa schedule install \| status \| uninstall` | Manage the background sync job              |
| `prosa setup`                        | Interactive first-run wizard                       |
| `prosa login`                        | Re-authenticate (sub-step of setup)                |

Useful flags everywhere:

- `--last 12h|7d|30d` — rolling window (default `7d`).
- `--since 2026-01-01` — anchored lower bound, UTC.
- `--between 2026-01-01..2026-03-15` — closed UTC range.
- `--project <name>` — project filter.
- `--agent claude-code|codex|cursor|gemini|antigravity|hermes` — agent filter.
- `--device <name-or-id>` — device filter (cross-device only).
- `--remote` — query the server instead of the local store.
- `--json` — machine-readable NDJSON output.

The three time flags (`--last`, `--since`, `--between`) are mutually
exclusive — pick one at a time.

By default data lives under `~/.local/share/prosa` (XDG). Override with
`PROSA_HOME`. Full reference: [`docs/usage.md`][docs-usage].


## Self-hosting (server + panel)

If you only use `prosa` locally, skip this. Each binary ships as its own
distroless Docker image — the image name tells you what it runs:

```sh
docker compose up -d                                          # Postgres + MinIO dev stack
docker run --rm ghcr.io/c3-oss/prosa-server:latest            # server
docker run --rm ghcr.io/c3-oss/prosa-panel:latest             # panel
docker run --rm ghcr.io/c3-oss/prosa:latest --help            # CLI
```

Env vars, auth, dev-login bypass, OAuth, schema details:
[`docs/self-hosting.md`][docs-self-hosting].


## Build from source

The repo uses [`devbox`][devbox] + [`just`][just]. Inside `devbox shell`:

```sh
just build               # builds ./bin/{prosa,prosa-server,prosa-panel}
just test                # go test ./...
just quality             # docs, links, agents, and secret scanning
just ci                  # full local pipeline (tidy/gen/vet/lint/test-race/build)
just snapshot            # local GoReleaser dry-run into dist/
```

The Devbox shell also installs the repo's Husky hooks for commit messages,
staged Markdown, agent config, and staged secret scanning.

The deeper guide — conventions, how to add a new importer, commit style —
lives in [`docs/contributing.md`][docs-contributing].


## Documentation map

```
INTENT.md                            philosophy, scope, trade-offs (read first)
README.md                            you are here
ROADMAP.md                           what is being worked on next
TECH_DEBT.md                         known trade-offs we've accepted
AGENTS.md                            operational guide for repo contributors
CLAUDE.md                            pointer for Claude Code agents

docs/
├── README.md                        documentation index
├── install.md                       end-user install across channels
├── usage.md                         CLI tutorial + command reference
├── self-hosting.md                  server + panel deployment
├── concepts.md                      session lifecycle, identity, MVP scope
├── contributing.md                  code conventions + adding an importer
├── agents.md                        AI agent orientation (full)
│
├── architecture/                    how the code is really structured
├── cli/                             CLI surface design (motion, rendering, screens)
├── panel/                           web panel design (screens, components, mocks)
├── sources/                         per-agent JSONL formats
└── distribution/                    homebrew, npm, install.sh, docker, release flow
```

[docs-install]: docs/install.md
[docs-usage]: docs/usage.md
[docs-self-hosting]: docs/self-hosting.md
[docs-contributing]: docs/contributing.md
[devbox]: https://www.jetify.com/devbox
[just]: https://github.com/casey/just


## For AI agents

If you are an AI agent working on this repo, orient yourself in this order:

1. [`INTENT.md`](INTENT.md) — read it end-to-end before proposing anything.
2. [`AGENTS.md`](AGENTS.md) — operational guide (paths, commands, conventions).
3. [`docs/agents.md`](docs/agents.md) — deeper orientation, decision
   checklist, where each specialist agent lives.

Specialist agents and skills are in `.codex/` and `.claude/`. They all point
back to `INTENT.md` and `docs/`; if you find a path reference that doesn't
exist, that is a bug — report it.


## Releases

Releases are tag-driven. Pushing a `v*` tag runs GoReleaser and publishes:

- macOS/Linux archives for `amd64` and `arm64`;
- `checksums.txt` (sha256);
- the Homebrew cask in [`c3-oss/homebrew-prosa`][brew-tap];
- the npm metapackage and four platform sub-packages;
- three multi-arch Docker images at `ghcr.io/c3-oss/{prosa,prosa-server,prosa-panel}:<tag>` and `:latest`.

Maintainer runbook: [`docs/distribution/release.md`][docs-release].

[brew-tap]: https://github.com/c3-oss/homebrew-prosa
[docs-release]: docs/distribution/release.md


## License

To the extent possible under law, [Caian Ertl][me] has waived __all copyright
and related or neighboring rights to this work__. In the spirit of _freedom of
information_, I encourage you to fork, modify, change, share, or do whatever
you like with this project! [`^C ^V`][kopimi]

[![License][cc-shield]][cc-url]

[me]: https://github.com/upsetbit
[cc-shield]: https://forthebadge.com/images/badges/cc-0.svg
[cc-url]: http://creativecommons.org/publicdomain/zero/1.0
[kopimi]: https://kopimi.com
