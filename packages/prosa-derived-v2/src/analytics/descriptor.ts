// Analytics views descriptor for MCP / CLI catalog consumers.
//
// `analyticsViewsDescriptor()` packages the existing
// `ANALYTICS_VIEW_NAMES`, `ANALYTICS_VIEW_COLUMNS`, and
// `analyticsViewSql()` exports into one queryable shape — an array
// of `{ name, columns, sql }` records, one per view. This is exactly
// the shape MCP `list_analytics_views`, the CLI
// `prosa analytics views` command, and a future web "available
// analytics" panel consume to enumerate the view catalog.
//
// `analyticsViewDescriptor(name)` returns a single record for a
// caller-known view. Throws on unknown names (mirrors
// `analyticsViewSql`'s strict-name policy).
//
// Pure read path — no filesystem touch, no DuckDB. Suitable for
// shipping in any process that exposes the catalog regardless of
// `@duckdb/node-api` allowlist status.

import { ANALYTICS_VIEW_COLUMNS, ANALYTICS_VIEW_NAMES, type AnalyticsViewName, analyticsViewSql } from './views.js'

export interface AnalyticsViewDescriptor {
  /** Canonical view name from `ANALYTICS_VIEW_NAMES`. */
  name: AnalyticsViewName
  /** Ordered list of columns the view exposes. Matches
   *  `ANALYTICS_VIEW_COLUMNS[name]` verbatim. */
  columns: readonly string[]
  /** DuckDB `CREATE OR REPLACE VIEW ... AS ...` body for this view
   *  (no terminating `;`). Sourced from `analyticsViewSql(name)`. */
  sql: string
}

/**
 * Build a per-view descriptor for `name`. Throws when `name` is not
 * a member of `ANALYTICS_VIEW_NAMES` so a misspelled name surfaces
 * a clear error rather than a descriptor with an `undefined`
 * `columns` / `sql`.
 */
export function analyticsViewDescriptor(name: AnalyticsViewName): AnalyticsViewDescriptor {
  if (!(ANALYTICS_VIEW_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `analyticsViewDescriptor: unknown view ${JSON.stringify(name)}; valid names are ${ANALYTICS_VIEW_NAMES.join(', ')}`,
    )
  }
  return {
    name,
    columns: ANALYTICS_VIEW_COLUMNS[name],
    sql: analyticsViewSql(name),
  }
}

/**
 * Build descriptors for every analytics view in
 * `ANALYTICS_VIEW_NAMES` order. The result is the catalog shape
 * MCP `list_analytics_views`, CLI `prosa analytics views`, and web
 * analytics-panel consumers want: name + column list + SQL body
 * per view, with no per-view fan-out by the caller.
 *
 * Returned descriptors are fresh objects on each call (no shared
 * mutable state); the `columns` field is the frozen
 * `ANALYTICS_VIEW_COLUMNS` entry, so callers that mutate it would
 * fail at the type / runtime level.
 */
export function analyticsViewsDescriptor(): AnalyticsViewDescriptor[] {
  return ANALYTICS_VIEW_NAMES.map((name) => analyticsViewDescriptor(name))
}
