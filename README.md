# prosa

`prosa` is a local-first CLI for compiling, searching, auditing, and exporting
agent session histories.

It imports local histories from Codex CLI, Claude Code, Gemini CLI, and Cursor
into one canonical bundle so you can search across tools, inspect prior work,
export readable transcripts, and run analytical queries without giving up the
original raw data.

## What it does

- Imports session histories from multiple agent CLIs into a single local store.
- Preserves raw source files and raw records for future re-processing.
- Normalizes sessions, messages, tool calls, tool results, artifacts, and graph
  edges into SQLite tables.
- Builds searchable derived indexes over messages, commands, paths, and result
  previews.
- Lists and filters sessions by source and timestamp.
- Exports individual sessions as Markdown.
- Exports canonical tables to Parquet for DuckDB analytics.
- Provides an Ink-based terminal UI for browsing sessions and search results.
- Serves a read-only MCP server over the local bundle for agent memory access.

`prosa` is early software, but the main CLI surfaces described below are
implemented.

## Quick start

From this repository:

```bash
devbox shell
pnpm install
pnpm build
```

During development, run commands through SWC:

```bash
pnpm dev -- init
pnpm dev -- compile codex
pnpm dev -- sessions
pnpm dev -- search "terraform"
```

After building or installing the package, use the `prosa` binary:

```bash
prosa init
prosa compile-all

prosa sessions --source codex --since 2026-01-01
prosa search "package.json"
prosa export session <session-id> --format markdown --out session.md
prosa export parquet
prosa query duckdb "select source_tool, count(*) from sessions group by 1"
prosa tui
prosa mcp serve
```

By default, the bundle is stored at `~/.prosa`. Override it with `--store` or
the `PROSA_STORE` environment variable:

```bash
PROSA_STORE=/tmp/prosa-demo prosa init
prosa sessions --store /tmp/prosa-demo
```

## Supported sources

`prosa compile` imports one source at a time. If `--sessions-path` is omitted,
the provider default is used:

```bash
prosa compile codex [--sessions-path <path>]
prosa compile claude [--sessions-path <path>]
prosa compile gemini [--sessions-path <path>]
prosa compile cursor [--sessions-path <path>]
prosa compile-all [--verbose] [--json-logs]
```

Supported importers:

| Source | Typical path | Imported files |
|---|---|---|
| Codex CLI | `~/.codex/sessions` | Recursive `.jsonl` session files |
| Claude Code | `~/.claude/projects` | Project JSONL files and subagent JSONL files |
| Gemini CLI | `~/.gemini/tmp` | `chats/session-*.json` snapshots |
| Cursor | `~/.cursor/chats` | `store.db` SQLite agent stores |

Imports are idempotent for already-seen source files. Each import reports counts
for source files, sessions, messages, tool calls, tool results, artifacts,
edges, and errors.

For large imports, you can defer FTS5 index updates and rebuild later:

```bash
prosa compile codex --defer-index
prosa index fts5
```

## CLI reference

### `prosa init`

Initialize a bundle:

```bash
prosa init
prosa init --store /path/to/bundle
```

If the bundle already exists, `init` exits with an error unless
`--force-existing` is passed:

```bash
prosa init --force-existing
```

### `prosa compile`

Import session histories into the bundle:

```bash
prosa compile codex
prosa compile claude
prosa compile gemini
prosa compile cursor
```

Override a provider source path:

```bash
prosa compile codex --sessions-path ~/custom/codex/sessions
```

Import every supported provider with default paths:

```bash
prosa compile-all
```

Options:

| Option | Description |
|---|---|
| `--sessions-path <path>` | Root of the selected provider's session history |
| `--store <path>` | Bundle directory |
| `--defer-index` | Skip immediate FTS5 updates; run `prosa index fts5` later |
| `--verbose` | Emit debug logs during compilation |
| `--json-logs` | Emit raw JSON logs instead of pretty logs |

`prosa compile-all` accepts only the logging flags. It uses provider defaults and
the normal `PROSA_STORE` environment variable when the bundle path must be
overridden.

### `prosa index`

Build or inspect derived search indexes:

```bash
prosa index status
prosa index fts5
prosa index tantivy
```

`fts5` is the default SQLite full-text index. It is updated during normal
imports unless `--defer-index` is used.

`tantivy` is an optional sidecar search index. Build it before searching with
`--engine tantivy`:

```bash
prosa index tantivy
prosa search "migration error" --engine tantivy
```

`index status` supports machine-readable output:

```bash
prosa index status --output-format json
```

### `prosa sessions`

List sessions in the bundle:

```bash
prosa sessions
prosa sessions --source claude
prosa sessions --since 2026-01-01
prosa sessions --until 2026-02-01
prosa sessions --limit 100
```

Count sessions with the same filters:

```bash
prosa sessions count
prosa sessions count --source cursor --since 2026-01-01
```

Session list output includes timestamp, source tool, `session_id`, model,
message count, tool call count, initial working directory, and title.

Output formats:

```bash
prosa sessions --output-format table
prosa sessions --output-format json
prosa sessions --output-format csv
```

The `interactive` output format is accepted by headless commands and currently
renders as a table. Use `prosa tui` for the interactive browser.

### `prosa search`

Search messages, tool calls, paths, commands, and result previews:

```bash
prosa search "terraform"
prosa search "package.json" --limit 20
prosa search "failed migration" --output-format json
prosa search "schema update" --engine fts5
prosa search "schema update" --engine tantivy
```

The default engine is `fts5`. The Tantivy engine requires a sidecar index:

```bash
prosa index tantivy
prosa search "indexing" --engine tantivy
```

Search output includes timestamp, role, tool name, session ID, and a snippet.

### `prosa export session`

Export a single session as Markdown:

```bash
prosa export session <session-id> --format markdown
prosa export session <session-id> --format markdown --out transcript.md
```

Markdown exports include source metadata, prosa and source session IDs,
timestamps, working directory, branch, model span, timeline confidence,
messages, and related tool calls.

Large outputs are not intended to be dumped wholesale into Markdown. The export
renders useful previews while the full bytes remain in the content-addressed
object store.

### `prosa export parquet`

Export canonical SQLite tables to Parquet:

```bash
prosa export parquet
prosa export parquet --out /tmp/prosa-parquet
```

The export writes one `.parquet` file per canonical table plus a manifest. These
files are derived analytics snapshots, not the source of truth.

Exported tables include:

```text
objects, source_files, import_batches, raw_records, import_errors,
uncertainties, projects, sessions, turns, events, messages, content_blocks,
tool_calls, tool_results, artifacts, edges, search_docs
```

### `prosa query duckdb`

Run DuckDB SQL over exported Parquet tables:

```bash
prosa export parquet
prosa query duckdb "select source_tool, count(*) from sessions group by 1"
```

Use a custom Parquet directory:

```bash
prosa query duckdb \
  --parquet-dir /tmp/prosa-parquet \
  "select tool_name, count(*) from tool_calls group by 1 order by 2 desc"
```

Output formats:

```bash
prosa query duckdb "select count(*) as n from sessions" --output-format json
prosa query duckdb "select * from sessions limit 10" --output-format csv
```

### `prosa tui`

Open the Ink-based interactive explorer:

```bash
prosa tui
prosa tui --store /path/to/bundle
```

Key bindings:

| Key | Action |
|---|---|
| `j` / `k` or arrows | Move selection or scroll detail view |
| `Enter` | Open the selected session |
| `/` | Search |
| `s` | Cycle source filter |
| `R` | Reload |
| `Esc` | Return to the session list |
| `gg` / `G` | Jump to top or bottom |
| `Ctrl-d` / `Ctrl-u` | Half-page down or up |
| `q` | Quit from the session list |

### `prosa mcp serve`

Start a local read-only MCP server over the bundle. The default transport is
stdio, suitable for MCP clients that launch a command through `npx` or a local
binary:

```bash
prosa mcp serve
npx @c3-oss/prosa mcp serve
prosa mcp serve --transport stdio
prosa mcp serve --search-engine tantivy
```

Example MCP client command config:

```json
{
  "command": "npx",
  "args": ["@c3-oss/prosa", "mcp", "serve"]
}
```

In stdio mode, stdout is reserved for MCP JSON-RPC frames. Do not expect normal
human-readable startup logs on stdout.

To expose MCP over HTTP Streamable transport, pass `--transport http`:

```bash
prosa mcp serve --transport http
prosa mcp serve --transport http --host 127.0.0.1 --port 7331 --path /mcp
prosa mcp serve --transport http --search-engine tantivy
```

By default, HTTP mode listens at:

```text
http://127.0.0.1:7331/mcp
```

Registered MCP tools include:

| Tool | Purpose |
|---|---|
| `list_sessions` | List recent sessions with optional source/date filters |
| `get_session` | Return metadata and timeline events for one session |
| `search_sessions` | Full-text search over indexed session content |
| `export_session_markdown` | Render a selected session as Markdown |
| `list_tool_calls` | Audit commands and tool usage |
| `find_touched_files` | Find sessions that touched a file/path |
| `get_artifact` | Retrieve stored artifact text when available |
| `index_status` | Show derived search index status |

Registered MCP prompts include:

| Prompt | Purpose |
|---|---|
| `investigate_prior_work` | Search prior work on a topic and cite evidence |
| `find_file_history` | Investigate history for a file or path |
| `audit_tool_failures` | Group and explain failed tool calls |

All MCP tools are read-only and use the same services as the CLI.

## Common workflows

### Import everything local

```bash
prosa init --force-existing
prosa compile-all
prosa index status
```

### Find prior work on a topic

```bash
prosa search "auth middleware"
prosa sessions --source codex --limit 20
prosa export session <session-id> --format markdown
```

### Audit failed or suspicious tool usage

Use MCP `list_tool_calls` for the richest tool-call filtering, or query Parquet:

```bash
prosa export parquet
prosa query duckdb "
  select tool_name, status, count(*) as n
  from tool_calls
  group by 1, 2
  order by n desc
"
```

### Search faster with a sidecar index

```bash
prosa index tantivy
prosa search "slow test" --engine tantivy
prosa index status
```

### Keep an isolated test bundle

```bash
prosa init --store /tmp/prosa-demo
prosa compile codex --store /tmp/prosa-demo
prosa tui --store /tmp/prosa-demo
```

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
| Raw immutable layer | Preserved source files, raw records, import batches, import errors |
| Canonical projection | Projects, sessions, turns, events, messages, blocks, tool calls, tool results, artifacts, edges |
| Derived read surfaces | `search_docs`, SQLite FTS5, Tantivy sidecar, Markdown, Parquet |

SQLite is the canonical catalog. Large payloads such as raw records, tool
outputs, diffs, and JSON payloads are stored in the content-addressed object
store. Object IDs use BLAKE3 and object bytes are compressed with zstd.

Raw source files are preserved so future importer versions can rebuild better
projections without re-reading the original tool history directories.

Search indexes, Markdown exports, and Parquet files are derived. Do not treat
them as the source of truth.

## Development

Requirements:

- Node.js 22 or newer
- pnpm
- devbox, recommended for the local shell

Useful commands:

```bash
pnpm install
pnpm dev -- <command>
just build
just test
just lint
just typecheck
pnpm build
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm typecheck
pnpm lint
pnpm lint:fix
pnpm format
pnpm clean
```

Examples:

```bash
pnpm dev -- init --store /tmp/prosa-dev
pnpm dev -- compile codex --store /tmp/prosa-dev
pnpm dev -- sessions --store /tmp/prosa-dev --output-format json
```

Project layout:

| Path | Purpose |
|---|---|
| `src/cli/commands/` | CLI command implementations |
| `src/core/` | Bundle, schema, CAS, domain IDs, ingest helpers |
| `src/importers/` | Codex, Claude, Gemini, and Cursor importers |
| `src/services/` | Sessions, search, indexing, exports |
| `src/mcp/` | MCP server, tools, and prompts |
| `src/tui/` | Ink terminal UI |
| `test/` | Vitest tests and fixtures |
| `docs/` | Design and recovery notes |

## Releasing

`prosa` uses Changesets for local npm releases to the official npm registry.
The package is published publicly as `@c3-oss/prosa`.

Create a changeset for user-facing changes:

```bash
just changeset
```

Apply pending changesets to `package.json` and `CHANGELOG.md`:

```bash
just version-packages
```

Build and publish:

```bash
just release
```

Publishing requires an npm account authenticated locally with permission to
publish public packages under the `@c3-oss` scope. Do not run `just release`
unless you intend to publish to `https://registry.npmjs.org/`.

## Status and limitations

- Version is currently `0.1.0`.
- Source formats for agent tools can change; importers preserve raw bytes so
  projections can be improved later.
- FTS5 is available by default; Tantivy search requires `prosa index tantivy`
  before use.
- `prosa query duckdb` requires Parquet exports. Run `prosa export parquet`
  after importing or re-importing data.
- Markdown export is optimized for readable transcripts and previews, not for
  dumping every stored byte inline.
- The default store may contain private local history. Be careful before
  sharing exports, Parquet snapshots, or the bundle itself.

## Why this exists

Every agent CLI keeps history in its own format. Searching across tools is
painful, auditing tool calls is harder, and exporting human-readable transcripts
is inconsistent.

`prosa` reduces that fragmentation into one queryable local store while
preserving provenance and raw source bytes for auditability and future
re-processing.
