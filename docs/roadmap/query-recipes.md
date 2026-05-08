# Query Recipes

## Goal

Collect practical DuckDB recipes for questions users are likely to ask of their
agent history.

## Current State

The README contains a few short examples, and `docs/recipes/duckdb.md` now
contains an initial recipe catalog.

## Proposed Recipe Areas

- Session inventory by source tool, project, model, and time range.
- Tool usage counts by tool name, canonical type, status, and project.
- Failed or suspicious tool activity by status, exit code, and error preview.
- Long-running commands and high-duration tool calls.
- Sessions with low timeline confidence or importer uncertainties.
- Prompt and response search using `search_docs` metadata.
- Model transitions within a session.
- Project activity over daily or weekly buckets.

## Implementation Notes

Create recipes as documentation first. They should use `prosa query duckdb` and
the currently exported canonical tables. As analytics views land, recipes can
move toward those views while keeping canonical-table examples where useful.

Each recipe should include:

- The question it answers.
- The command to run.
- Expected output shape.
- Notes about limitations or privacy.

## Acceptance Criteria

- A `docs/recipes/duckdb.md` or equivalent page exists with at least ten
  copy-pasteable queries.
- README links to the recipe catalog from the Parquet/DuckDB sections.
- At least a small subset of recipes is exercised in tests or fixture-backed
  examples when output shape matters.

Initial implementation status: `docs/recipes/duckdb.md` includes recipes over
the canonical Parquet table views and the analytics views.

## Risks

Recipes can go stale as table columns evolve. Prefer simple queries and update
them alongside schema changes.
