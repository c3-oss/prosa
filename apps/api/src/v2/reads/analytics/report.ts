// Lane 6 — `POST /v2/reads/analytics/report` handler.
//
// Returns one of the five fixed Lane 6 analytics reports
// (sessions, tools, errors, models, projects). Each report runs
// directly against the gate-aware verified-projection set so
// superseded rows never contribute. Reports use the
// cross-store-distinct collapsing path so a logical session
// promoted by N stores appears once per logical id, matching the
// `sessions/list` contract.
//
// Filters: `sourceTools`, `since`, `until`. Limit caps each
// report at 500 rows by default (max 5000).

import { z } from 'zod'
import type { RawExec } from '../../../db.js'
import { verifiedProjectionWhere } from '../shared/verified-projection.js'

export const ANALYTICS_REPORTS = ['sessions', 'tools', 'errors', 'models', 'projects'] as const
export type AnalyticsReportKind = (typeof ANALYTICS_REPORTS)[number]

// CQ-147 follow-up: strict() makes the schema reject unknown keys
// at the wire boundary so a client cannot pass through a filter the
// handler will silently drop (which would invite the wrong impression
// that, e.g., `model: 'gpt-5'` filtered the report).
export const analyticsReportInput = z
  .object({
    report: z.enum(ANALYTICS_REPORTS),
    sourceTools: z.array(z.string().min(1)).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().int().min(1).max(5000).default(500),
  })
  .strict()

export type AnalyticsReportInput = z.infer<typeof analyticsReportInput>

export type AnalyticsReportRow = Record<string, string | number | null>

export type AnalyticsReportResponse = {
  report: AnalyticsReportKind
  generatedAt: string
  rows: AnalyticsReportRow[]
}

export type AnalyticsReportDeps = {
  rawExec: RawExec
  /** Override for tests; defaults to `new Date()`. */
  now?: () => Date
}

function appendParam(params: unknown[], value: unknown): string {
  params.push(value)
  return `$${params.length}`
}

type FilterBuild = {
  params: unknown[]
  /** Filter clauses applied to the verified-projection alias. */
  appendFilters(alias: 's' | 't' | 'c' | 'r' | 'p'): string
}

function startFilters(tenantId: string, input: AnalyticsReportInput): FilterBuild {
  const params: unknown[] = [tenantId]
  let sourceToolsClause = ''
  if (input.sourceTools && input.sourceTools.length > 0) {
    const placeholders = input.sourceTools.map((t) => appendParam(params, t)).join(', ')
    sourceToolsClause = `AND %alias%.source_tool IN (${placeholders})`
  }
  let sinceClause = ''
  if (input.since) {
    const param = appendParam(params, input.since)
    sinceClause = `AND %alias%.start_ts >= ${param}::timestamptz`
  }
  let untilClause = ''
  if (input.until) {
    const param = appendParam(params, input.until)
    untilClause = `AND %alias%.start_ts < ${param}::timestamptz`
  }
  return {
    params,
    appendFilters(alias) {
      return [sourceToolsClause, sinceClause, untilClause]
        .filter((s) => s.length > 0)
        .map((s) => s.replaceAll('%alias%', alias))
        .join(' ')
    },
  }
}

export async function getAnalyticsReport(
  deps: AnalyticsReportDeps,
  tenantId: string,
  input: AnalyticsReportInput,
): Promise<AnalyticsReportResponse> {
  const generatedAt = (deps.now ?? (() => new Date()))().toISOString()
  switch (input.report) {
    case 'sessions':
      return { report: 'sessions', generatedAt, rows: await runSessionsReport(deps.rawExec, tenantId, input) }
    case 'tools':
      return { report: 'tools', generatedAt, rows: await runToolsReport(deps.rawExec, tenantId, input) }
    case 'errors':
      return { report: 'errors', generatedAt, rows: await runErrorsReport(deps.rawExec, tenantId, input) }
    case 'models':
      return { report: 'models', generatedAt, rows: await runModelsReport(deps.rawExec, tenantId, input) }
    case 'projects':
      return { report: 'projects', generatedAt, rows: await runProjectsReport(deps.rawExec, tenantId, input) }
  }
}

async function runSessionsReport(
  rawExec: RawExec,
  tenantId: string,
  input: AnalyticsReportInput,
): Promise<AnalyticsReportRow[]> {
  // Cross-store distinct: one row per logical session.
  const f = startFilters(tenantId, input)
  const limitParam = appendParam(f.params, input.limit)
  const rows = await rawExec<{
    source_tool: string
    source_session_id: string
    session_id: string
    title: string | null
    project_id: string | null
    store_id: string
    receipt_id: string
    start_ts: string | null
    end_ts: string | null
    duration_seconds: number | null
  }>(
    `SELECT DISTINCT ON (s.source_tool, s.source_session_id)
            s.source_tool,
            s.source_session_id,
            s.session_id,
            s.title,
            s.project_id,
            s.store_id,
            s.receipt_id,
            to_char(s.start_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_ts,
            to_char(s.end_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_ts,
            CASE
              WHEN s.start_ts IS NOT NULL AND s.end_ts IS NOT NULL
                THEN GREATEST(0, EXTRACT(EPOCH FROM (s.end_ts - s.start_ts)))::int
              ELSE NULL
            END AS duration_seconds
       FROM projection_session s
      WHERE ${verifiedProjectionWhere('s')}
        ${f.appendFilters('s')}
      ORDER BY s.source_tool, s.source_session_id, s.end_ts DESC NULLS LAST, s.receipt_id DESC
      LIMIT ${limitParam}`,
    f.params,
  )
  return rows.map((r) => ({ ...r }))
}

// CQ-147: every aggregate report consults the same cross-store
// picked-session CTE so a logical session promoted by N stores
// contributes exactly once. The CTE bakes the analytics filters in
// so since/until/sourceTools narrow the picked set before any
// counting happens.
function buildPickedSessionsCte(tenantId: string, input: AnalyticsReportInput, params: unknown[]): string {
  params.push(tenantId)
  const tenantParam = `$${params.length}`
  const localFilters = startFilters(tenantId, input)
  // `startFilters` reserved `$1` for tenant — we want to reuse the
  // existing params array instead. Rebuild manually here with the
  // current params cursor.
  // sourceTools
  let sourceToolsClause = ''
  if (input.sourceTools && input.sourceTools.length > 0) {
    const placeholders = input.sourceTools.map((t) => appendParam(params, t)).join(', ')
    sourceToolsClause = `AND s.source_tool IN (${placeholders})`
  }
  let sinceClause = ''
  if (input.since) {
    sinceClause = `AND s.start_ts >= ${appendParam(params, input.since)}::timestamptz`
  }
  let untilClause = ''
  if (input.until) {
    untilClause = `AND s.start_ts < ${appendParam(params, input.until)}::timestamptz`
  }
  void localFilters
  return `
    WITH picked_sessions AS (
      SELECT DISTINCT ON (s.source_tool, s.source_session_id)
             s.session_id, s.source_tool, s.source_session_id, s.project_id, s.start_ts
        FROM projection_session s
       WHERE ${verifiedProjectionWhere('s', tenantParam)}
         ${sourceToolsClause}
         ${sinceClause}
         ${untilClause}
       ORDER BY s.source_tool, s.source_session_id, s.end_ts DESC NULLS LAST, s.receipt_id DESC
    )
  `
}

async function runToolsReport(
  rawExec: RawExec,
  tenantId: string,
  input: AnalyticsReportInput,
): Promise<AnalyticsReportRow[]> {
  const params: unknown[] = []
  const cte = buildPickedSessionsCte(tenantId, input, params)
  const limitParam = appendParam(params, input.limit)
  // Each invocation belongs to exactly one logical session via the
  // picked-sessions CTE; the JOIN collapses cross-store duplicates.
  const rows = await rawExec<{
    tool_name: string
    canonical_tool_type: string | null
    invocation_count: number
    error_count: number
    distinct_sessions: number
  }>(
    `${cte}
     SELECT c.tool_name,
            c.canonical_tool_type,
            count(*)::int AS invocation_count,
            count(*) FILTER (
              WHERE lower(COALESCE(c.status, '')) IN ('error','failed','failure')
                 OR EXISTS (
                   SELECT 1 FROM projection_tool_result r
                    WHERE r.tenant_id = c.tenant_id
                      AND r.tool_call_id = c.tool_call_id
                      AND r.is_error = TRUE
                 )
            )::int AS error_count,
            count(DISTINCT c.session_id)::int AS distinct_sessions
       FROM projection_tool_call c
       JOIN picked_sessions ps ON ps.session_id = c.session_id
      WHERE ${verifiedProjectionWhere('c')}
      GROUP BY c.tool_name, c.canonical_tool_type
      ORDER BY invocation_count DESC, c.tool_name ASC
      LIMIT ${limitParam}`,
    params,
  )
  return rows.map((r) => ({ ...r }))
}

async function runErrorsReport(
  rawExec: RawExec,
  tenantId: string,
  input: AnalyticsReportInput,
): Promise<AnalyticsReportRow[]> {
  const params: unknown[] = []
  const cte = buildPickedSessionsCte(tenantId, input, params)
  const limitParam = appendParam(params, input.limit)
  const rows = await rawExec<{
    tool_name: string
    error_count: number
    distinct_sessions: number
  }>(
    `${cte}
     SELECT c.tool_name,
            count(*)::int AS error_count,
            count(DISTINCT c.session_id)::int AS distinct_sessions
       FROM projection_tool_call c
       JOIN picked_sessions ps ON ps.session_id = c.session_id
      WHERE ${verifiedProjectionWhere('c')}
        AND (
          lower(COALESCE(c.status, '')) IN ('error','failed','failure')
          OR EXISTS (
            SELECT 1 FROM projection_tool_result r
             WHERE r.tenant_id = c.tenant_id
               AND r.tool_call_id = c.tool_call_id
               AND r.is_error = TRUE
          )
        )
      GROUP BY c.tool_name
      ORDER BY error_count DESC, c.tool_name ASC
      LIMIT ${limitParam}`,
    params,
  )
  return rows.map((r) => ({ ...r }))
}

async function runModelsReport(
  rawExec: RawExec,
  tenantId: string,
  input: AnalyticsReportInput,
): Promise<AnalyticsReportRow[]> {
  const params: unknown[] = []
  const cte = buildPickedSessionsCte(tenantId, input, params)
  const limitParam = appendParam(params, input.limit)
  // The projection schema does not carry `model_first` / `model_last`
  // columns on `projection_session` (CQ-134 deferred their
  // materialization to Lane 10), so we derive distinct
  // `(model)` pairs from `projection_message` joined to the
  // cross-store-collapsed session set.
  const rows = await rawExec<{
    model: string | null
    message_count: number
    distinct_sessions: number
  }>(
    `${cte}
     SELECT m.model,
            count(*)::int AS message_count,
            count(DISTINCT m.session_id)::int AS distinct_sessions
       FROM projection_message m
       JOIN picked_sessions ps ON ps.session_id = m.session_id
      WHERE ${verifiedProjectionWhere('m')}
      GROUP BY m.model
      ORDER BY message_count DESC, m.model ASC NULLS LAST
      LIMIT ${limitParam}`,
    params,
  )
  return rows.map((r) => ({ ...r }))
}

async function runProjectsReport(
  rawExec: RawExec,
  tenantId: string,
  input: AnalyticsReportInput,
): Promise<AnalyticsReportRow[]> {
  const f = startFilters(tenantId, input)
  const limitParam = appendParam(f.params, input.limit)
  const rows = await rawExec<{
    project_id: string | null
    session_count: number
    latest_session_ts: string | null
  }>(
    `SELECT s.project_id,
            count(*)::int AS session_count,
            to_char(MAX(s.start_ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest_session_ts
       FROM (
         SELECT DISTINCT ON (s.source_tool, s.source_session_id)
                s.project_id, s.start_ts, s.source_tool, s.source_session_id
           FROM projection_session s
          WHERE ${verifiedProjectionWhere('s')}
            ${f.appendFilters('s')}
          ORDER BY s.source_tool, s.source_session_id, s.end_ts DESC NULLS LAST, s.receipt_id DESC
       ) s
      GROUP BY s.project_id
      ORDER BY session_count DESC, s.project_id ASC NULLS LAST
      LIMIT ${limitParam}`,
    f.params,
  )
  return rows.map((r) => ({ ...r }))
}
