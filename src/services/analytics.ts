import type { Bundle } from '../core/bundle.js';
import { clampLimit } from '../core/limits.js';
import { type DuckDbQueryResult, queryDuckDbParquet } from './export/parquet.js';

export const ANALYTICS_REPORTS = ['sessions', 'tools', 'errors', 'models', 'projects'] as const;
export type AnalyticsReport = (typeof ANALYTICS_REPORTS)[number];

export type AnalyticsDialect = 'sqlite' | 'duckdb';

export interface AnalyticsReportFilters {
  source?: string;
  since?: string;
  until?: string;
  limit?: number;
  toolName?: string;
  canonicalType?: string;
  errorsOnly?: boolean;
  category?: string;
  model?: string;
  project?: string;
  sessionId?: string;
  sourcePathSubstring?: string;
}

export interface AnalyticsReportOptions {
  parquetDir: string;
  report: AnalyticsReport;
  filters?: AnalyticsReportFilters;
}

export interface AnalyticsBundleReportOptions {
  bundle: Bundle;
  report: AnalyticsReport;
  filters?: AnalyticsReportFilters;
}

export async function runAnalyticsReport(
  options: AnalyticsReportOptions,
): Promise<DuckDbQueryResult> {
  return queryDuckDbParquet({
    parquetDir: options.parquetDir,
    sql: buildAnalyticsSql(options.report, options.filters ?? {}, 'duckdb'),
  });
}

export function runAnalyticsReportFromBundle(
  options: AnalyticsBundleReportOptions,
): DuckDbQueryResult {
  const sql = buildAnalyticsSql(options.report, options.filters ?? {}, 'sqlite');
  const stmt = options.bundle.db.prepare<unknown[], Record<string, unknown>>(sql);
  const rows = stmt.all();
  const columns = stmt.columns().map((column) => column.name);
  return { columns, rows };
}

function buildAnalyticsSql(
  report: AnalyticsReport,
  filters: AnalyticsReportFilters,
  dialect: AnalyticsDialect,
): string {
  switch (report) {
    case 'sessions':
      return buildSessionsSql(filters, dialect);
    case 'tools':
      return buildToolsSql(filters, dialect);
    case 'errors':
      return buildErrorsSql(filters, dialect);
    case 'models':
      return buildModelsSql(filters, dialect);
    case 'projects':
      return buildProjectsSql(filters, dialect);
  }
}

function buildSessionsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('start_ts', filters),
    projectFilter(filters, dialect),
    filters.sessionId ? `session_id = ${sqlString(filters.sessionId)}` : null,
    filters.sourcePathSubstring
      ? `source_file_path LIKE ${sqlString(`%${escapeLike(filters.sourcePathSubstring)}%`)} ESCAPE '\\'`
      : null,
  ]);
  return `
    SELECT start_ts, source_tool, project_name, source_file_path, session_id,
           source_session_id, model_last, duration_seconds,
           message_count, tool_call_count, tool_result_count, tool_error_count,
           tool_duration_ms, timeline_confidence, title
      FROM session_facts
      ${where}
     ORDER BY start_ts DESC NULLS LAST
     LIMIT ${limit(filters)}
  `;
}

function buildToolsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('timestamp_start', filters),
    projectFilter(filters, dialect),
    filters.toolName ? `tool_name = ${sqlString(filters.toolName)}` : null,
    filters.canonicalType ? `canonical_tool_type = ${sqlString(filters.canonicalType)}` : null,
    filters.errorsOnly ? `(is_error = 1 OR call_status = 'error')` : null,
  ]);
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
  `;
}

function buildErrorsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('timestamp', filters),
    projectFilter(filters, dialect),
    filters.toolName ? `tool_name = ${sqlString(filters.toolName)}` : null,
    filters.category ? `error_category = ${sqlString(filters.category)}` : null,
  ]);
  return `
    SELECT timestamp, error_category, source_tool, project_name, session_id,
           tool_name, status, exit_code, message, preview
      FROM error_facts
      ${where}
     ORDER BY timestamp DESC NULLS LAST, error_id DESC
     LIMIT ${limit(filters)}
  `;
}

function buildModelsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    rangeOverlapFilter('first_seen_ts', 'last_seen_ts', filters),
    projectFilter(filters, dialect),
    filters.model ? `model = ${sqlString(filters.model)}` : null,
  ]);
  return `
    SELECT model, source_tool, project_name, session_count, turn_count,
           message_count, observation_count, first_seen_ts, last_seen_ts
      FROM model_usage
      ${where}
     ORDER BY session_count DESC, observation_count DESC, model ASC
     LIMIT ${limit(filters)}
  `;
}

function buildProjectsSql(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string {
  const where = buildWhere([
    sourceFilter(filters),
    rangeOverlapFilter('first_session_ts', 'latest_session_ts', filters),
    projectFilter(filters, dialect),
  ]);
  return `
    SELECT latest_session_ts, source_tool, project_name, project_path,
           session_count, message_count, tool_call_count, tool_error_count,
           low_confidence_session_count
      FROM project_activity
      ${where}
     ORDER BY latest_session_ts DESC NULLS LAST, session_count DESC, project_name ASC
     LIMIT ${limit(filters)}
  `;
}

function sourceFilter(filters: AnalyticsReportFilters): string | null {
  return filters.source ? `source_tool = ${sqlString(filters.source)}` : null;
}

function timeFilter(column: string, filters: AnalyticsReportFilters): string | null {
  const filtersSql: string[] = [];
  if (filters.since)
    filtersSql.push(`(${column} IS NULL OR ${column} >= ${sqlString(filters.since)})`);
  if (filters.until)
    filtersSql.push(`(${column} IS NULL OR ${column} < ${sqlString(filters.until)})`);
  return filtersSql.length ? filtersSql.join(' AND ') : null;
}

function rangeOverlapFilter(
  firstColumn: string,
  lastColumn: string,
  filters: AnalyticsReportFilters,
): string | null {
  const filtersSql: string[] = [];
  if (filters.since) {
    filtersSql.push(`(${lastColumn} IS NULL OR ${lastColumn} >= ${sqlString(filters.since)})`);
  }
  if (filters.until) {
    filtersSql.push(`(${firstColumn} IS NULL OR ${firstColumn} < ${sqlString(filters.until)})`);
  }
  return filtersSql.length ? filtersSql.join(' AND ') : null;
}

function projectFilter(filters: AnalyticsReportFilters, dialect: AnalyticsDialect): string | null {
  if (!filters.project) return null;
  const exact = sqlString(filters.project);
  const like = sqlString(`%${escapeLike(filters.project)}%`);
  // DuckDB's LIKE is case-sensitive, ILIKE is case-insensitive. SQLite's LIKE
  // is case-insensitive for ASCII by default, so we use LIKE there.
  const op = dialect === 'duckdb' ? 'ILIKE' : 'LIKE';
  return `(project_id = ${exact} OR project_name ${op} ${like} ESCAPE '\\' OR project_path ${op} ${like} ESCAPE '\\')`;
}

function buildWhere(filters: Array<string | null>): string {
  const active = filters.filter((filter): filter is string => Boolean(filter));
  return active.length ? `WHERE ${active.join(' AND ')}` : '';
}

function limit(filters: AnalyticsReportFilters): number {
  const value = Number.isFinite(filters.limit) ? filters.limit : undefined;
  return clampLimit(value, { max: 500, fallback: 50 });
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
