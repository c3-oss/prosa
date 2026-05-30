# prosa

`prosa` consolidates AI agent sessions (Claude Code, Codex, others) into a
unified, queryable history so you can answer "what did I work on in the last
N days?" without context-switching between tool surfaces.

This branch is the v3 Go rewrite. The product intent — scope, principles,
architecture, schema, CLI surface, distribution — lives in [`INTENT.md`](INTENT.md).

## Build

```
devbox shell           # Go 1.24 + buf + linter pinned via Nix
make tools             # install protoc-gen-go + protoc-gen-connect-go into ./bin
make build             # produces ./bin/prosa, ./bin/prosa-server, ./bin/prosa-panel
```

Full pipeline locally:

```
make ci                # tidy + tools + gen + lint + test + build + git diff --exit-code
```

## Status

First cut: client-side vertical slice only — Claude Code importer, local
SQLite store, `prosa` timeline. Server and panel binaries compile as stubs.
See `INTENT.md` §3 for the cut roadmap.

## History

The v2 TS/Node monorepo is preserved at the tag `legacy-v2` and the branch
`v3-stash`. Recover any file with `git show legacy-v2:<path>`.
