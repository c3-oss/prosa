import type { Bundle } from '../core/bundle.js'
import { clampLimit } from '../core/limits.js'
import { type DuckDbQueryResult, queryDuckDbParquet } from './export/parquet.js'

/** Stable report names exposed by CLI and MCP analytics surfaces. */
export const ANALYTICS_REPORTS = ['sessions', 'tools', 'errors', 'models', 'projects'] as const

/** Analytics report identifier. */
export type AnalyticsReport = (typeof ANALYTICS_REPORTS)[number]

/** SQL dialects supported by the analytics query builder. */
export type AnalyticsDialect = 'sqlite' | 'duckdb'

/** Cross-report filters accepted by analytics read surfaces. */
export interface AnalyticsReportFilters {
  /** Source tool filter. */
  source?: string
  /** Inclusive lower time bound for report-specific timestamps. */
  since?: string
  /** Exclusive upper time bound for report-specific timestamps. */
  until?: string
  /** Maximum row count, clamped by service limits. */
  limit?: number
  /** Native tool name filter for tool/error reports. */
  toolName?: string
  /** Canonical tool category filter. */
  canonicalType?: string
  /** Restrict tool/error reports to failed operations. */
  errorsOnly?: boolean
  /** Error category filter. */
  category?: string
  /** Model name filter. */
  model?: string
  /** Project name filter. */
  project?: string
  /** Canonical session identifier filter. */
  sessionId?: string
  /** Source file path substring filter. */
  sourcePathSubstring?: string
}

/** Options for running an analytics report against exported Parquet files. */
export interface AnalyticsReportOptions {
  /** Directory containing exported Parquet tables. */
  parquetDir: string
  /** Report to run. */
  report: AnalyticsReport
  /** Optional report filters. */
  filters?: AnalyticsReportFilters
}

/** Options for running an analytics report directly against a SQLite bundle. */
export interface AnalyticsBundleReportOptions {
  /** Open bundle queried through SQLite analytics views. */
  bundle: Bundle
  /** Report to run. */
  report: AnalyticsReport
  /** Optional report filters. */
  filters?: AnalyticsReportFilters
}

/** Runs a fixed analytics report over DuckDB views backed by Parquet exports. */
export async function runAnalyticsReport(options: AnalyticsReportOptions): Promise<DuckDbQueryResult> {
  return queryDuckDbParquet({
    parquetDir: options.parquetDir,
    sql: buildAnalyticsSql(options.report, options.filters ?? {}, 'duckdb'),
  })
}

/** Runs the same fixed analytics reports against SQLite analytics views. */
export function runAnalyticsReportFromBundle(options: AnalyticsBundleReportOptions): DuckDbQueryResult {
  const sql = buildAnalyticsSql(options.report, options.filters ?? {}, 'sqlite')
  const stmt = options.bundle.db.prepare<unknown[], Record<string, unknown>>(sql)
  const rows = stmt.all()
  const columns = stmt.columns().map((column) => column.name)
  return { columns, rows }
}

/** Dispatches to the report-specific SQL template for the requested dialect. */
function buildAnalyticsSql(
  report: AnalyticsReport,
  filters: AnalyticsReportFilters,
  dialect: AnalyticsDialect,
): string {
  switch (report) {
    case 'sessions':
      return buildSessionsSql(filters, dialect)
    case 'tools':
      return buildToolsSql(filters, dialect)
    case 'errors':
      return buildErrorsSql(filters, dialect)
    case 'models':
      return buildModelsSql(filters, dialect)
    case 'projects':
      return buildProjectsSql(filters, dialect)
  }
}

/** Builds the session_facts report query with stable output columns. */
function buildSessionsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('start_ts', filters),
    projectFilter(filters, dialect),
    filters.sessionId ? `session_id = ${sqlString(filters.sessionId)}` : null,
    filters.sourcePathSubstring
      ? `source_file_path LIKE ${sqlString(`%${escapeLike(filters.sourcePathSubstring)}%`)} ESCAPE '\\'`
      : null,
  ])
  return `
    SELECT start_ts, source_tool, project_name, source_file_path, session_id,
           source_session_id, model_last, duration_seconds,
           message_count, tool_call_count, tool_result_count, tool_error_count,
           tool_duration_ms, timeline_confidence, title
      FROM session_facts
      ${where}
     ORDER BY start_ts DESC NULLS LAST
     LIMIT ${limit(filters)}
  `
}

/** Builds the tool_usage_facts aggregate query grouped by tool and project. */
function buildToolsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('timestamp_start', filters),
    projectFilter(filters, dialect),
    filters.toolName ? `tool_name = ${sqlString(filters.toolName)}` : null,
    filters.canonicalType ? `canonical_tool_type = ${sqlString(filters.canonicalType)}` : null,
    filters.errorsOnly ? `(is_error = 1 OR call_status = 'error')` : null,
  ])
  return `
    SELECT tool_name, canonical_tool_type, source_tool, project_name,
           count(*) AS call_count,
           sum(CASE WHEN is_error = 1 OR call_status = 'error' THEN 1 ELSE 0 END) AS error_count,
           round(avg(result_duration_ms), 3) AS avg_result_duration_ms,
           max(timestamp_start) AS latest_ts
      FROM tool_usage_facts
      ${where}
     GROUP BY tool_name, canonical_tool_type, source_tool, project_name
     ORDER BY call_count DESC, error_count DESC, tool_name ASC
     LIMIT ${limit(filters)}
  `
}

/** Builds the error_facts detail query for tool, import, and uncertainty errors. */
function buildErrorsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('timestamp', filters),
    projectFilter(filters, dialect),
    filters.toolName ? `tool_name = ${sqlString(filters.toolName)}` : null,
    filters.category ? `error_category = ${sqlString(filters.category)}` : null,
  ])
  return `
    SELECT timestamp, error_category, source_tool, project_name, session_id,
           tool_name, status, exit_code, message, preview
      FROM error_facts
      ${where}
     ORDER BY timestamp DESC NULLS LAST, error_id DESC
     LIMIT ${limit(filters)}
  `
}

/** Builds the model_usage report using range-overlap filtering semantics. */
function buildModelsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    rangeOverlapFilter('first_seen_ts', 'last_seen_ts', filters),
    projectFilter(filters, dialect),
    filters.model ? `model = ${sqlString(filters.model)}` : null,
  ])
  return `
    SELECT model, source_tool, project_name, session_count, turn_count,
           message_count, observation_count, first_seen_ts, last_seen_ts
      FROM model_usage
      ${where}
     ORDER BY session_count DESC, observation_count DESC, model ASC
     LIMIT ${limit(filters)}
  `
}

/** Builds the project_activity rollup query. */
function buildProjectsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    rangeOverlapFilter('first_session_ts', 'latest_session_ts', filters),
    projectFilter(filters, dialect),
  ])
  return `
    SELECT latest_session_ts, source_tool, project_name, project_path,
           session_count, message_count, tool_call_count, tool_error_count,
           low_confidence_session_count
      FROM project_activity
      ${where}
     ORDER BY latest_session_ts DESC NULLS LAST, session_count DESC, project_name ASC
     LIMIT ${limit(filters)}
  `
}

/** Builds an exact source_tool predicate when a source filter is present. */
function sourceFilter(filters: AnalyticsReportFilters): string | null {
  return filters.source ? `source_tool = ${sqlString(filters.source)}` : null
}

/** Applies point-in-time bounds while retaining rows with unknown timestamps. */
function timeFilter(column: string, filters: AnalyticsReportFilters): string | null {
  const filtersSql: string[] = []
  if (filters.since) filtersSql.push(`(${column} IS NULL OR ${column} >= ${sqlString(filters.since)})`)
  if (filters.until) filtersSql.push(`(${column} IS NULL OR ${column} < ${sqlString(filters.until)})`)
  return filtersSql.length ? filtersSql.join(' AND ') : null
}

/** Applies date bounds to fact rows whose observed span overlaps the filter range. */
function rangeOverlapFilter(firstColumn: string, lastColumn: string, filters: AnalyticsReportFilters): string | null {
  const filtersSql: string[] = []
  if (filters.since) {
    filtersSql.push(`(${lastColumn} IS NULL OR ${lastColumn} >= ${sqlString(filters.since)})`)
  }
  if (filters.until) {
    filtersSql.push(`(${firstColumn} IS NULL OR ${firstColumn} < ${sqlString(filters.until)})`)
  }
  return filtersSql.length ? filtersSql.join(' AND ') : null
}

/** Builds the project matcher, accounting for SQLite and DuckDB LIKE semantics. */
function projectFilter(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string | null {
  if (!filters.project) return null
  const exact = sqlString(filters.project)
  const like = sqlString(`%${escapeLike(filters.project)}%`)
  // DuckDB's LIKE is case-sensitive, ILIKE is case-insensitive. SQLite's LIKE
  // is case-insensitive for ASCII by default, so we use LIKE there.
  const op = dialect === 'duckdb' ? 'ILIKE' : 'LIKE'
  return `(project_id = ${exact} OR project_name ${op} ${like} ESCAPE '\\' OR project_path ${op} ${like} ESCAPE '\\')`
}

/** Joins active predicates into a WHERE clause. */
function buildWhere(filters: Array<string | null>): string {
  const active = filters.filter((filter): filter is string => Boolean(filter))
  return active.length ? `WHERE ${active.join(' AND ')}` : ''
}

/** Clamps analytics report limits to the service maximum. */
function limit(filters: AnalyticsReportFilters): number {
  const value = Number.isFinite(filters.limit) ? filters.limit : undefined
  return clampLimit(value, { max: 500, fallback: 50 })
}

/** Quotes a SQL string literal for fixed-template analytics SQL. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Escapes wildcards in user-provided LIKE fragments. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}
