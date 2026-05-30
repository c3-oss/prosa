[![CI][ci-shield]][ci-url]
[![Release][rel-shield]][rel-url]
[![GitHub tag][tag-shield]][tag-url]

# `prosa`

> a work log for AI-agent sessions

`prosa` turns scattered Claude Code and Codex JSONL histories into one local,
searchable timeline. It is built for a very specific daily question:

> what did I work on in the last few days?

The v3 rewrite is intentionally small: SQLite for the local index, raw JSONL
preserved on disk, a fast CLI for reading the history, and a typed server/panel
shape ready for the next MVP cuts.

[ci-shield]: https://img.shields.io/github/actions/workflow/status/c3-oss/prosa/ci.yml?label=ci&logo=github&style=flat-square
[ci-url]: https://github.com/c3-oss/prosa/actions/workflows/ci.yml
[rel-shield]: https://img.shields.io/github/actions/workflow/status/c3-oss/prosa/release.yml?label=release&logo=github&style=flat-square
[rel-url]: https://github.com/c3-oss/prosa/actions/workflows/release.yml
[tag-shield]: https://img.shields.io/github/tag/c3-oss/prosa.svg?logo=git&logoColor=FFF&style=flat-square
[tag-url]: https://github.com/c3-oss/prosa/releases


## Timeline

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

The default view is local and offline. When `prosa` can recognize the current
project, it scopes the timeline automatically; use `--all` to read across
everything.


## Usage

```sh
prosa sync                         # import local agent sessions
prosa                              # last 7 days
prosa --last 30d --all             # broader timeline
prosa search "sqlite FTS"           # full-text search over turns
prosa show <session-id>             # print preserved raw JSONL
prosa analytics sessions            # 5 fixed reports: sessions|tools|models|projects|errors
```

### Cross-device (Group B)

```sh
docker compose up -d                                       # Postgres + MinIO dev stack
PROSA_DB_URL=... ./bin/prosa-server                        # boot the API (see docs/server.md)
prosa login --server http://localhost:7070                 # device-code flow → ~/.config/prosa/auth.json
prosa sync                                                  # imports + pushes to the server
prosa devices                                               # list known machines
prosa search "term" --remote                                # Postgres FTS instead of local FTS5
prosa analytics sessions --remote                           # sessions / projects only in this cut
```

Useful flags:

- `--last 12h|7d|30d` — time window.
- `--project <name>` — project filter.
- `--agent claude-code|codex` — agent filter.
- `--device <name>` — device filter.
- `--json` — machine-readable output where supported.

By default, data lives under `~/.local/share/prosa`. Set `PROSA_HOME` to point
the store somewhere else.


## Run with Docker

Images are published to GitHub Container Registry:

```sh
docker run --rm ghcr.io/c3-oss/prosa:latest
```

The image contains all three binaries. `prosa-server` is the default entrypoint;
to run the CLI instead:

```sh
docker run --rm --entrypoint prosa ghcr.io/c3-oss/prosa:latest --help
```


## Build from Source

This repo uses [`devbox`][devbox] + [`just`][just]. Inside `devbox shell`:

```sh
just build                         # builds ./bin/prosa*
./bin/prosa --version
```

Common targets:

```sh
just test                          # go test ./...
just test-race                     # go test -race -count=1 ./...
just lint                          # golangci-lint run ./...
just gen-check                     # buf generate must not change gen/
just snapshot                      # local GoReleaser dry-run into dist/
```

[devbox]: https://www.jetify.com/devbox
[just]: https://github.com/casey/just


## Project Shape

`prosa` is one Go module with three binaries:

- `prosa` — local CLI with cross-device support via `--remote`.
- `prosa-server` — Connect API server (Postgres + S3-compatible). Push, list,
  search, devices; auth via device-code flow. See [`docs/server.md`](docs/server.md).
- `prosa-panel` — future web panel; stub until Group D.

The canonical importer contract lives in [`docs/canonical-session.md`](docs/canonical-session.md).
The product and architecture source of truth lives in [`INTENT.md`](INTENT.md).


## Releases

Releases are tag-driven. Pushing a `v*` tag runs GoReleaser and publishes:

- macOS/Linux archives for `amd64` and `arm64`;
- `checksums.txt`;
- a multi-arch Docker image at `ghcr.io/c3-oss/prosa:<tag>` and `:latest`.


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
