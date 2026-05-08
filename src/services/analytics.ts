import { clampLimit } from '../core/limits.js';
import { type DuckDbQueryResult, queryDuckDbParquet } from './export/parquet.js';

export const ANALYTICS_REPORTS = ['sessions', 'tools', 'errors', 'models', 'projects'] as const;
export type AnalyticsReport = (typeof ANALYTICS_REPORTS)[number];

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
}

export interface AnalyticsReportOptions {
  parquetDir: string;
  report: AnalyticsReport;
  filters?: AnalyticsReportFilters;
}

export async function runAnalyticsReport(
  options: AnalyticsReportOptions,
): Promise<DuckDbQueryResult> {
  return queryDuckDbParquet({
    parquetDir: options.parquetDir,
    sql: buildAnalyticsSql(options.report, options.filters ?? {}),
  });
}

function buildAnalyticsSql(report: AnalyticsReport, filters: AnalyticsReportFilters): string {
  switch (report) {
    case 'sessions':
      return buildSessionsSql(filters);
    case 'tools':
      return buildToolsSql(filters);
    case 'errors':
      return buildErrorsSql(filters);
    case 'models':
      return buildModelsSql(filters);
    case 'projects':
      return buildProjectsSql(filters);
  }
}

function buildSessionsSql(filters: AnalyticsReportFilters): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('start_ts', filters),
    projectFilter(filters),
  ]);
  return `
    SELECT start_ts, source_tool, project_name, session_id, model_last,
           message_count, tool_call_count, tool_error_count, tool_duration_ms,
           timeline_confidence, title
      FROM session_facts
      ${where}
     ORDER BY start_ts DESC NULLS LAST
     LIMIT ${limit(filters)}
  `;
}

function buildToolsSql(filters: AnalyticsReportFilters): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('timestamp_start', filters),
    projectFilter(filters),
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

function buildErrorsSql(filters: AnalyticsReportFilters): string {
  const where = buildWhere([
    sourceFilter(filters),
    timeFilter('timestamp', filters),
    projectFilter(filters),
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

function buildModelsSql(filters: AnalyticsReportFilters): string {
  const where = buildWhere([
    sourceFilter(filters),
    rangeOverlapFilter('first_seen_ts', 'last_seen_ts', filters),
    projectFilter(filters),
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

function buildProjectsSql(filters: AnalyticsReportFilters): string {
  const where = buildWhere([
    sourceFilter(filters),
    rangeOverlapFilter('first_session_ts', 'latest_session_ts', filters),
    projectFilter(filters),
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

function projectFilter(filters: AnalyticsReportFilters): string | null {
  if (!filters.project) return null;
  const exact = sqlString(filters.project);
  const like = sqlString(`%${escapeLike(filters.project)}%`);
  return `(project_id = ${exact} OR project_name ILIKE ${like} ESCAPE '\\' OR project_path ILIKE ${like} ESCAPE '\\')`;
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
