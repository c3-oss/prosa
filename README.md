# prosa — Query your agent history. Keep the raw trail.

[![npm version](https://img.shields.io/npm/v/@c3-oss/prosa.svg)](https://www.npmjs.com/package/@c3-oss/prosa)
[![Node version](https://img.shields.io/node/v/@c3-oss/prosa.svg)](https://www.npmjs.com/package/@c3-oss/prosa)
[![License](https://img.shields.io/npm/l/@c3-oss/prosa.svg)](https://www.npmjs.com/package/@c3-oss/prosa)

`prosa` imports local AI agent session histories into one durable, searchable bundle on your machine. It understands Codex CLI, Claude Code, Gemini CLI, Cursor, and Hermes, preserves the raw files, normalizes everything into SQLite, builds search indexes, and exposes the bundle through a CLI, a terminal UI, MCP, and an optional sync server.

Package: [`@c3-oss/prosa`](https://www.npmjs.com/package/@c3-oss/prosa)

## Installation

```bash
npm install -g @c3-oss/prosa
# or
npx --package @c3-oss/prosa prosa --help
```

Requires Node.js 22.15.1 through 26.x.

## Quickstart

```bash
prosa v1 init
prosa v1 compile-all
prosa v1 sessions
prosa v1 search "package.json"
```

The bundle defaults to `~/.prosa`. Override with `--store <path>` per command or `PROSA_STORE=<path>` for the shell:

```bash
PROSA_STORE=/tmp/prosa-demo prosa v1 init
prosa v1 compile codex --store /tmp/prosa-demo
```

## Supported sources

| Source | Default path |
|---|---|
| Codex CLI | `~/.codex/sessions` |
| Claude Code | `~/.claude/projects` |
| Gemini CLI | `~/.gemini/tmp` |
| Cursor | `~/.cursor/chats` |
| Hermes | `~/.hermes/sessions` |

Each importer preserves raw bytes and produces idempotent imports. Per-source format references live under [`docs/sources/`](./docs/sources/).

## What ships

- Five importers (Codex, Claude Code, Gemini CLI, Cursor, Hermes).
- SQLite catalog plus content-addressed object store.
- Full-text search via SQLite FTS5 (default) or an optional Tantivy sidecar.
- Markdown transcript export and Parquet export for DuckDB.
- Five built-in analytics reports plus a `query duckdb` escape hatch.
- Ink-based terminal UI and an MCP server (stdio or HTTP).
- One-way sync server (`apps/api`) with multi-tenant auth and remote-authoritative reads.

The full command surface and flags live in [`docs/README.md`](./docs/README.md).

## MCP

`prosa v1 mcp serve` exposes the bundle as an MCP server with six tools (`search`, `sessions`, `tool_calls`, `analytics`, `artifact`, `compile`) and three prompts (`investigate_prior_work`, `find_file_history`, `audit_tool_failures`):

```bash
prosa v1 mcp serve
prosa v1 mcp serve --transport http --host 127.0.0.1 --port 7331 --path /mcp
```

Stdio mode reserves stdout for MCP JSON-RPC frames. Example stdio client config:

```json
{
  "command": "npx",
  "args": ["--package", "@c3-oss/prosa", "prosa", "v1", "mcp", "serve"]
}
```

See [`docs/README.md`](./docs/README.md) for the architecture details.

## Documentation

Start with [`docs/README.md`](./docs/README.md) for the full reference:

- Architecture — bundle format, import pipeline, search engines, analytics, server sync.
- Source formats — Codex, Claude Code, Cursor, Gemini, Hermes.
- Recipes — DuckDB queries over Parquet exports.
- Agent workflows — governed Claude Ralph Loop implementation runs.

Forward-looking work lives in [`ROADMAP.md`](./ROADMAP.md). The browser product
surface now lives in the `apps/web` workspace.

## Development

```bash
devbox shell      # optional, recommended
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Run the CLI through SWC while developing:

```bash
pnpm dev -- v1 init --store /tmp/prosa-dev
pnpm dev -- v1 compile codex --store /tmp/prosa-dev
```

The repo is a pnpm + Turbo monorepo with `apps/{cli,api}` and `packages/prosa-{core,db,storage,sync}`. See [`AGENTS.md`](./AGENTS.md) for repo conventions and [`docs/README.md`](./docs/README.md) for subsystem references.

## Releasing

`prosa` uses Changesets for npm releases. The package publishes publicly as `@c3-oss/prosa`.

```bash
just changeset
just version-packages
just release
```

`just release` publishes to `https://registry.npmjs.org/`. Do not run it without npm credentials for the `@c3-oss` scope.

## Status and limitations

- `prosa` is early software. The CLI surface is stable, but importer coverage continues to evolve as agent tools change their on-disk formats. Raw bytes are preserved so projections can be improved later.
- FTS5 is available by default. Tantivy requires `prosa v1 index tantivy` before use.
- `prosa v1 query duckdb` and `prosa v1 analytics` require Parquet exports — run `prosa v1 export parquet` first, or pass `--refresh` to rebuild before querying.
- Markdown export is optimized for readable transcripts and previews, not exhaustive dumps.
- The default store may contain private local history. Be careful before sharing exports, Parquet snapshots, or the bundle itself.
