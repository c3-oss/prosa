// Analytics execution plan composition.
//
// The view definitions in `./views.ts` ship column-shape contracts and
// DuckDB SQL bodies. The runtime executor (`@duckdb/node-api`-backed,
// landing in a follow-up) will need:
//
//   1. one statement per canonical entity to bind a Parquet read as a
//      temporary view (the preamble);
//   2. one statement to create the analytics view itself; and
//   3. a final query that selects from the analytics view.
//
// This module composes that sequence into an ordered `setupStatements`
// list plus a `reportQuery` string. No DuckDB connection is opened and
// no statements are executed; the result is a pure data structure
// callers (and tests) can inspect. The runtime executor consumes the
// list verbatim, so the column shape it surfaces stays locked to
// `columns`.

import {
  ANALYTICS_ENTITY_TABLES,
  ANALYTICS_VIEW_COLUMNS,
  ANALYTICS_VIEW_NAMES,
  type AnalyticsViewName,
  analyticsViewSql,
  parquetReadFor,
} from './views.js'

/** Ordered statement sequence a runtime DuckDB executor consumes to
 *  materialise an analytics view and run a report query against it. */
export interface AnalyticsExecutionPlan {
  /** Selected analytics view. Locked at plan time so the runtime
   *  cannot drift from the column-shape contract. */
  view: AnalyticsViewName
  /** Canonical, ordered column-shape contract for `view`. Identical
   *  to `ANALYTICS_VIEW_COLUMNS[view]`. The runtime must surface
   *  results with these names in this order. */
  columns: readonly string[]
  /** Statements the runtime issues in order before running the
   *  report query. The first `ANALYTICS_ENTITY_TABLES.length` entries
   *  are the preamble (one `CREATE OR REPLACE TEMP VIEW` per
   *  canonical entity, bound to the live + compacted Parquet
   *  overlay); the last entry is the analytics
   *  `CREATE OR REPLACE VIEW <view> AS ...` body. Each entry is a
   *  single semicolon-terminated DuckDB statement; the runtime
   *  executes them in order before issuing `reportQuery`. */
  setupStatements: string[]
  /** Report query the runtime returns rows from. Defaults to
   *  `SELECT * FROM <view>;` but callers may pass a custom
   *  `SELECT ...` that joins the view with another query. The
   *  composition layer does not validate or rewrite this string —
   *  the caller is the authority on its own report. */
  reportQuery: string
}

export interface PlanAnalyticsExecutionInput {
  /** Absolute bundle root. The preamble globs
   *  `<bundleRoot>/epochs/*​/projection/<entity>.parquet` plus the
   *  compacted overlay. */
  bundleRoot: string
  /** Which analytics view to materialise. */
  view: AnalyticsViewName
  /** Optional caller-supplied report query. Defaults to
   *  `SELECT * FROM <view>;`. The string is taken verbatim, so
   *  callers must terminate with a semicolon. */
  reportQuery?: string
}

/**
 * Compose the ordered statement sequence a runtime DuckDB executor
 * uses to materialise `view` and run a report query against it. The
 * returned `setupStatements` array contains, in order:
 *
 *   1. `CREATE OR REPLACE TEMP VIEW <entity> AS SELECT * FROM
 *      read_parquet([live_glob, compact_glob], union_by_name => true);`
 *      — one per `ANALYTICS_ENTITY_TABLES`.
 *   2. `CREATE OR REPLACE VIEW <view> AS ...` — the analytics view
 *      body from `analyticsViewSql(view)`, ending with a `;`.
 *
 * The report query defaults to `SELECT * FROM <view>;`.
 *
 * Throws when `view` is not a member of `ANALYTICS_VIEW_NAMES`. The
 * input is not otherwise validated — the runtime executor will surface
 * any SQL errors at execution time (e.g. no Parquet files yet).
 */
export function planAnalyticsExecution(input: PlanAnalyticsExecutionInput): AnalyticsExecutionPlan {
  if (!ANALYTICS_VIEW_NAMES.includes(input.view)) {
    throw new Error(
      `planAnalyticsExecution: unknown view ${JSON.stringify(input.view)} (expected one of: ${ANALYTICS_VIEW_NAMES.join(', ')})`,
    )
  }
  const setupStatements: string[] = []
  for (const entity of ANALYTICS_ENTITY_TABLES) {
    setupStatements.push(
      `CREATE OR REPLACE TEMP VIEW ${entity} AS SELECT * FROM ${parquetReadFor(input.bundleRoot, entity)};`,
    )
  }
  const viewBody = analyticsViewSql(input.view)
  setupStatements.push(viewBody.endsWith(';') ? viewBody : `${viewBody};`)

  const reportQuery = input.reportQuery ?? `SELECT * FROM ${input.view};`

  return {
    view: input.view,
    columns: ANALYTICS_VIEW_COLUMNS[input.view],
    setupStatements,
    reportQuery,
  }
}
