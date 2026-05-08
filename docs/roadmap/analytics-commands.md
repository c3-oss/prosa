# Analytics Commands

## Goal

Provide high-level CLI commands for common analytics tasks without requiring
users to write DuckDB SQL.

## Current State

Users can run custom SQL with `prosa query duckdb`, and the CLI now exposes
initial named reports through `prosa analytics`.

## Proposed Commands

- `prosa analytics sessions`: summarize sessions by source, project, model,
  status, and time range.
- `prosa analytics tools`: summarize tool names, canonical tool types, result
  statuses, durations, and error rates.
- `prosa analytics errors`: list import errors, failed tool results, and
  low-confidence records.
- `prosa analytics models`: summarize model usage by source, project, and time.
- `prosa analytics projects`: summarize project activity and recent sessions.

Each command should support the existing output formats where practical:
`table`, `json`, and `csv`.

## Implementation Notes

Build these commands on top of DuckDB and the Parquet export. The commands can
reuse the same internal query runner as `prosa query duckdb`, but should own
their SQL so output remains stable.

For the first version, commands may require an existing Parquet export and
return the same missing-export guidance as `prosa query duckdb`. A later version
could add `--refresh` to run `prosa export parquet` before the report.

Initial implementation status: the first version includes `--refresh`, common
filters, and reports for sessions, tools, errors, models, and projects.

## Acceptance Criteria

- At least one command, likely `prosa analytics tools`, ships with tests and
  documented examples.
- Commands accept `--store`, `--parquet-dir`, and `--output-format`.
- JSON output is stable enough for scripts.
- Errors clearly tell users how to create or refresh the Parquet export.

## Risks

Reports can drift from user needs if added too broadly. Start with a small set
of reports backed by real workflows and keep raw SQL available for everything
else.
