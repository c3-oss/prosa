# prosa - Query your agent history. Keep the raw trail.

[![npm version](https://img.shields.io/npm/v/@c3-oss/prosa.svg)](https://www.npmjs.com/package/@c3-oss/prosa)
[![Node version](https://img.shields.io/node/v/@c3-oss/prosa.svg)](https://www.npmjs.com/package/@c3-oss/prosa)
[![License](https://img.shields.io/npm/l/@c3-oss/prosa.svg)](https://www.npmjs.com/package/@c3-oss/prosa)

`prosa` imports local AI agent session histories into one durable, searchable
bundle on your machine.

It understands Codex CLI, Claude Code, Gemini CLI, Cursor, and Hermes. It preserves the
original raw files, normalizes sessions into SQLite, builds search indexes,
exports readable transcripts, writes Parquet for DuckDB, opens a terminal UI,
and serves the same local memory over MCP.

Use it when you want to know what your agents already did, which files or
commands they touched, where a failure happened, or how to reuse prior work
without reading provider-specific JSONL and SQLite files by hand.

Package: [`@c3-oss/prosa`](https://www.npmjs.com/package/@c3-oss/prosa)

## Installation

Install the published package globally:

```bash
npm install -g @c3-oss/prosa
```

Or run it without a global install:

```bash
npx --package @c3-oss/prosa prosa --help
```

The package provides the `prosa` binary and requires Node.js 22.15.1 through
26.x.

## Quickstart

Build a local bundle from every supported default history location:

```bash
prosa init
prosa compile-all
prosa sessions
prosa search "package.json"
```

Export a transcript and run analytics:

```bash
prosa export session <session-id> --format markdown --out session.md
prosa export parquet
prosa query duckdb "select source_tool, count(*) from sessions group by 1"
prosa analytics tools --refresh
```

Open the terminal UI or serve the bundle through MCP:

```bash
prosa tui
prosa mcp serve
```

By default, the bundle lives at `~/.prosa`. Override it with `--store` or
`PROSA_STORE`:

```bash
PROSA_STORE=/tmp/prosa-demo prosa init
prosa compile codex --store /tmp/prosa-demo
prosa search "migration" --store /tmp/prosa-demo
```

## Why prosa

Agent tools store useful work in different formats and directories. That makes
history hard to search, audit, export, or share with another agent.

`prosa` turns those histories into a local-first data layer:

- raw source files and raw records stay available for audit and re-processing;
- canonical SQLite tables make sessions, messages, tool calls, artifacts, and
  graph edges queryable;
- search surfaces cover messages, commands, paths, diffs, and result previews;
- derived exports give humans Markdown and analytics tools Parquet;
- MCP exposes the same bundle to agents as reusable local memory.

## Features

- Import Codex CLI, Claude Code, Gemini CLI, Cursor, and Hermes session histories.
- Preserve raw bytes alongside normalized records.
- Search with SQLite FTS5 by default, or build an optional Tantivy sidecar.
- List sessions with filters for source, time range, columns, and output format.
- Export individual sessions as readable Markdown transcripts.
- Export canonical tables to Parquet and query them with DuckDB.
- Run built-in analytics reports for sessions, tools, errors, models, and
  projects.
- Browse sessions and search results in an Ink-based terminal UI.
- Serve MCP tools and prompts over stdio or HTTP Streamable transport.
- Run bundle health checks with `prosa doctor`.

## Supported sources

`prosa compile` imports one source at a time. `prosa compile-all` imports every
supported source from its default location.

| Source | Default path | Imported files |
|---|---|---|
| Codex CLI | `~/.codex/sessions` | Recursive `.jsonl` session files |
| Claude Code | `~/.claude/projects` | Project JSONL files and subagent JSONL files |
| Gemini CLI | `~/.gemini/tmp` | `chats/session-*.json` snapshots |
| Cursor | `~/.cursor/chats` | `store.db` SQLite agent stores |
| Hermes | `~/.hermes/sessions` | Sibling `state.db`, top-level JSONL transcripts, and `session_*.json` snapshots |

Examples:

```bash
prosa compile codex
prosa compile claude --sessions-path ~/custom/claude/projects
prosa compile gemini
prosa compile cursor
prosa compile hermes
prosa compile-all --verbose
```

Imports are idempotent for already-seen source files. Each import reports counts
for source files, sessions, messages, tool calls, tool results, artifacts,
edges, and errors.

## Common workflows

Import everything local:

```bash
prosa init --force-existing
prosa compile-all
prosa index status
```

Find prior work on a topic or file:

```bash
prosa search "auth middleware"
prosa search "src/server/routes.ts" --limit 20
prosa sessions --source codex --since 2026-01-01
```

Export a useful transcript:

```bash
prosa sessions --limit 20
prosa export session <session-id> --format markdown --out transcript.md
```

Audit failed tool usage:

```bash
prosa analytics tools --refresh --errors-only
prosa analytics errors --output-format json
```

Run custom SQL over Parquet:

```bash
prosa export parquet
prosa query duckdb "
  select tool_name, status, count(*) as n
  from tool_calls
  group by 1, 2
  order by n desc
"
```

Use a faster sidecar search index:

```bash
prosa index tantivy
prosa search "slow test" --engine tantivy
prosa index status
```

## Command map

| Command | Purpose |
|---|---|
| `prosa init` | Create a bundle directory with manifest, SQLite, lock file, and object store. |
| `prosa compile <source>` | Import one source: `codex`, `claude`, `gemini`, `cursor`, or `hermes`. |
| `prosa compile-all` | Import every supported source from default paths. |
| `prosa sessions` | List or count sessions with filters and table, JSON, or CSV output. |
| `prosa search <query>` | Full-text search across messages, tool calls, paths, commands, and previews. |
| `prosa index` | Inspect or rebuild FTS5 and Tantivy search indexes. |
| `prosa export session` | Export one session as Markdown. |
| `prosa export parquet` | Export canonical tables to Parquet for analytics. |
| `prosa query duckdb` | Run DuckDB SQL over exported Parquet tables and derived views. |
| `prosa analytics` | Run built-in reports for sessions, tools, errors, models, and projects. |
| `prosa tui` | Open the interactive terminal explorer. |
| `prosa mcp serve` | Serve the bundle through MCP over stdio or HTTP. |
| `prosa doctor` | Run bundle health checks. |

Most commands accept `--store <path>`. `PROSA_STORE` sets the default bundle
path for a shell session.

Useful output flags:

```bash
prosa sessions --output-format json
prosa sessions --columns start_ts,session_id,title
prosa search "schema update" --output-format json
prosa analytics sessions --columns all
```

## MCP

Start a local MCP server over the bundle:

```bash
prosa mcp serve
npx --package @c3-oss/prosa prosa mcp serve
prosa mcp serve --transport http --host 127.0.0.1 --port 7331 --path /mcp
```

Example stdio client config:

```json
{
  "command": "npx",
  "args": ["--package", "@c3-oss/prosa", "prosa", "mcp", "serve"]
}
```

MCP tools include:

| Tool | Purpose |
|---|---|
| `search` | Search messages, commands, paths, diffs, and previews. |
| `sessions` | List sessions or open a session as detail, summary, or Markdown. |
| `tool_calls` | Audit tool usage, errors, commands, and path-related artifacts. |
| `analytics` | Run aggregate reports over SQLite-backed views. |
| `artifact` | Fetch full stored text for an artifact. |
| `compile` | Return compile/index status, or import a source when args are provided. |

MCP prompts include `investigate_prior_work`, `find_file_history`, and
`audit_tool_failures`.

In stdio mode, stdout is reserved for MCP JSON-RPC frames.

## Bundle layout

A bundle is a local directory, defaulting to `~/.prosa`:

```text
~/.prosa/
  manifest.json
  prosa.sqlite
  prosa.lock
  objects/
    blake3/...
  raw/
    sources/
  search/
    tantivy/
  exports/
  parquet/
```

The layers are:

| Layer | Contents |
|---|---|
| Raw immutable layer | Source files, raw records, import batches, and import errors. |
| Canonical projection | Projects, sessions, turns, events, messages, tool calls, artifacts, and edges. |
| Derived read surfaces | `search_docs`, SQLite FTS5, Tantivy, Markdown, and Parquet. |

SQLite is the canonical catalog. Large payloads such as raw records, tool
outputs, diffs, and JSON payloads are stored in the content-addressed object
store. Object IDs use BLAKE3 and object bytes are compressed with zstd.

Search indexes, Markdown exports, and Parquet files are derived. Do not treat
them as the source of truth.

## Development

Requirements:

- Node.js 22.15.1 through 26.x
- pnpm
- devbox, recommended for the local shell

From this repository:

```bash
devbox shell
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Run the CLI through SWC while developing:

```bash
pnpm dev -- init --store /tmp/prosa-dev
pnpm dev -- compile codex --store /tmp/prosa-dev
pnpm dev -- sessions --store /tmp/prosa-dev --output-format json
```

Project layout:

| Path | Purpose |
|---|---|
| `apps/cli/src/cli/commands/` | CLI command implementations |
| `packages/prosa-core/src/core/` | Bundle, schema, CAS, domain IDs, and ingest helpers |
| `packages/prosa-core/src/importers/` | Codex, Claude, Gemini, Cursor, and Hermes importers |
| `packages/prosa-core/src/services/` | Sessions, search, indexing, exports, and analytics |
| `packages/prosa-core/src/mcp/` | MCP server, tools, and prompts |
| `apps/cli/src/tui/` | Ink terminal UI |
| `apps/cli/test/` | CLI Vitest tests |
| `packages/prosa-core/test/` | Core, importer, service, MCP, helper, and fixture tests |
| `docs/` | Architecture and source-format references |

## Documentation

Start with [`docs/README.md`](./docs/README.md) for the full documentation
index.

| Doc | Purpose |
|---|---|
| [`docs/architecture/bundle-format.md`](./docs/architecture/bundle-format.md) | Bundle layout, SQLite schema, CAS, and idempotency keys |
| [`docs/architecture/import-pipeline.md`](./docs/architecture/import-pipeline.md) | How imports walk sources, stage CAS, commit, and rebuild indexes |
| [`docs/architecture/search-engines.md`](./docs/architecture/search-engines.md) | FTS5 default search vs. Tantivy sidecar search |
| [`docs/recipes/duckdb.md`](./docs/recipes/duckdb.md) | Copy-pasteable DuckDB analytics queries |
| [`docs/sources/codex.md`](./docs/sources/codex.md) | Codex CLI source format |
| [`docs/sources/claude-code.md`](./docs/sources/claude-code.md) | Claude Code source format |
| [`docs/sources/cursor.md`](./docs/sources/cursor.md) | Cursor source format |
| [`docs/sources/gemini.md`](./docs/sources/gemini.md) | Gemini CLI source format |
| [`docs/sources/hermes.md`](./docs/sources/hermes.md) | Hermes source format |

## Releasing

`prosa` uses Changesets for npm releases to the official npm registry. The
package is published publicly as `@c3-oss/prosa`.

```bash
just changeset
just version-packages
just release
```

Publishing requires an npm account authenticated locally with permission to
publish public packages under the `@c3-oss` scope. Do not run `just release`
unless you intend to publish to `https://registry.npmjs.org/`.

## Status and limitations

- `prosa` is early software. The main CLI surfaces documented here are
  implemented, but source formats and importer coverage will continue to evolve.
- Agent tools can change their on-disk formats; importers preserve raw bytes so
  projections can be improved later.
- FTS5 is available by default; Tantivy search requires `prosa index tantivy`
  before use.
- `prosa query duckdb` requires Parquet exports. Run `prosa export parquet`
  after importing or re-importing data.
- Markdown export is optimized for readable transcripts and previews, not for
  dumping every stored byte inline.
- The default store may contain private local history. Be careful before
  sharing exports, Parquet snapshots, or the bundle itself.
