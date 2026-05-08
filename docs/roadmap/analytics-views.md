# Analytics Views

## Goal

Expose stable DuckDB views over the exported Parquet files for common analytics
questions. These views should be derived from the existing canonical Parquet
tables and should not become a new source of truth.

## Current State

`prosa export parquet` writes one Parquet file per canonical table. `prosa query
duckdb` creates one view per table plus initial analytics views and runs
user-provided SQL against those views.

## Proposed Views

- `session_facts`: one row per session, with source tool, project, title,
  timestamps, duration, model span, message count, tool call count, error count,
  and timeline confidence.
- `tool_usage_facts`: one row per tool call, joined to result status, exit code,
  duration, error flag, command/path/query fields, project, session, and source
  tool.
- `error_facts`: one row per import error, failed tool result, or low-confidence
  uncertainty, normalized into a common shape for auditing.
- `model_usage`: model usage by message, turn, and session, suitable for
  grouping by time, project, or source tool.
- `project_activity`: one row per project/source grouping, with sessions,
  messages, tool calls, errors, and latest activity.

## Implementation Notes

Implement the views in the DuckDB query setup path, not as stored files at
first. `queryDuckDbParquet()` can continue creating table views, then create
derived views with `CREATE OR REPLACE VIEW ... AS SELECT ...`.

The views should use only exported Parquet files and should keep column names
stable. Avoid reading CAS object bytes in the first version; object IDs and
previews are enough for analytics.

## Acceptance Criteria

- `prosa query duckdb "select * from session_facts limit 10"` works after
  `prosa export parquet`.
- Views are documented with column lists and example queries.
- Tests cover at least `session_facts` and `tool_usage_facts` against fixture
  data.
- The canonical table views remain available unchanged.

Initial implementation status: the five views above are created in the DuckDB
query setup path. Future work can add more views such as `turn_facts` if a
concrete workflow needs them.

## Risks

Derived view names can become accidental API. Keep them intentionally small,
documented, and versioned through normal schema/release notes when they change.
