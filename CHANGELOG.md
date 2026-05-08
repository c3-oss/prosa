# @c3-oss/prosa

## Unreleased

### Minor Changes

- Consolidate the MCP surface from 10 tools to 6 (`search`, `sessions`,
  `tool_calls`, `analytics`, `artifact`, `compile`). `compile` is now dual-mode:
  with no args it returns a status snapshot; with `source` (and optional
  `sessions_path`) it runs the import. `sessions` folds the previous list / get
  / markdown export tools via a `format` param. `analytics` exposes the same
  five built-in reports as the CLI, backed by SQLite views.
- Lift the analytics views (`session_facts`, `tool_usage_facts`, `error_facts`,
  `model_usage`, `project_activity`) into the SQLite schema as views (migration
  v3). The DuckDB/Parquet path keeps its mirror of the same shape, so MCP
  reads run against SQLite without spinning up DuckDB.

## 0.4.0

### Minor Changes

- Add an MCP session_metrics tool for session audits.

## 0.3.2

### Patch Changes

- Initialize MCP stores before tool calls.

## 0.3.1

### Patch Changes

- Various code improvements

## 0.3.0

### Minor Changes

- MCP tool to compile sessions and code quality gates

## 0.2.0

### Minor Changes

- Performance improvements, logging and a new CLI

## 0.1.1

### Patch Changes

- Fix the published `prosa` bin so it runs correctly when launched through `npx`.
