# BI-Friendly Datasets

## Goal

Add derived datasets that are easier to consume from BI tools, notebooks, and
dataframe libraries than the normalized canonical table export.

## Current State

Parquet currently mirrors canonical SQLite tables. This is good for fidelity and
debugging, but common analysis requires users to join many tables and understand
the internal schema.

## Proposed Datasets

Keep canonical table Parquets unchanged, then add a separate derived dataset
layout, for example under `parquet/analytics/`.

Candidate files:

- `sessions.dataset.parquet`: denormalized session facts.
- `messages.dataset.parquet`: message metadata with session and project fields.
- `tool_calls.dataset.parquet`: tool calls joined to result status and previews.
- `errors.dataset.parquet`: import errors, failed tool results, and
  uncertainties.
- `daily_activity.dataset.parquet`: pre-aggregated daily counts by source,
  project, model, and tool.

## Implementation Notes

The derived dataset should be generated from canonical tables, preferably using
DuckDB SQL during `prosa export parquet`. It should be safe to delete and
rebuild.

Dataset files should prefer simple scalar columns. Nested JSON can remain
available through object IDs in canonical tables; the BI-friendly layer should
optimize for grouping, filtering, charting, and joining.

## Acceptance Criteria

- Canonical Parquet files remain unchanged.
- Derived datasets are documented separately from canonical tables.
- Example DuckDB and Python/Polars reads work without custom SQL joins.
- The manifest records both canonical and derived dataset files.

## Risks

Denormalized datasets duplicate information and can imply stronger compatibility
than intended. Mark them as derived analytics surfaces and keep their contract
explicit.

