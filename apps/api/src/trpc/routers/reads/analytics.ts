import { z } from 'zod'
import { router, tenantProcedure } from '../../init.js'
import { appendParam, sourceFilter, tenantVerifiedProjectionSql, timeRangeFilter } from './shared.js'

const reportEnum = z.enum(['sessions', 'tools', 'errors', 'models', 'projects'])

const analyticsReportInput = z
  .object({
    report: reportEnum,
    limit: z.number().int().min(1).max(500).default(200),
  })
  .merge(timeRangeFilter)
  .merge(sourceFilter)

type AnalyticsInput = z.infer<typeof analyticsReportInput>
type AnalyticsResponse = { report: AnalyticsInput['report']; rows: Array<Record<string, unknown>>; generatedAt: string }

function buildSessionWhere(tenantId: string, input: AnalyticsInput): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [tenantId]
  const clauses = [tenantVerifiedProjectionSql('p', 'session')]
  if (input.sourceKinds && input.sourceKinds.length > 0) {
    const placeholders = input.sourceKinds.map((kind) => appendParam(params, kind)).join(', ')
    clauses.push(`p.source_kind IN (${placeholders})`)
  }
  if (input.since) {
    const param = appendParam(params, input.since)
    clauses.push(`p.started_at >= ${param}`)
  }
  if (input.until) {
    const param = appendParam(params, input.until)
    clauses.push(`p.started_at < ${param}`)
  }
  return { whereSql: clauses.join(' AND '), params }
}

function reportResponse(input: AnalyticsInput, rows: Array<Record<string, unknown>>): AnalyticsResponse {
  return {
    report: input.report,
    rows,
    generatedAt: new Date().toISOString(),
  }
}

export const analyticsRouter = router({
  /** Lightweight dashboard summary, retained from the prior surface. */
  summary: tenantProcedure.query(async ({ ctx }) => {
    const counts = await ctx.rawExec<{
      sessions: number
      objects: number
      docs: number
      sources: number
    }>(
      `SELECT
          (SELECT count(*)::int FROM "projection_session" p WHERE ${tenantVerifiedProjectionSql('p', 'session')}) AS sessions,
          (SELECT count(DISTINCT m.object_id)::int
             FROM "sync_batch_object_manifest" m
             JOIN "sync_batch" b ON b.id = m.batch_id AND b.tenant_id = m.tenant_id AND b.status = 'verified'
            WHERE m.tenant_id = $1) AS objects,
          (SELECT count(*)::int FROM "search_doc" d WHERE ${tenantVerifiedProjectionSql('d', 'search_doc')}) AS docs,
          (SELECT count(distinct p.source_kind)::int FROM "projection_session" p WHERE ${tenantVerifiedProjectionSql('p', 'session')}) AS sources`,
      [ctx.tenantId],
    )
    const sourceBreakdown = await ctx.rawExec<{ source_kind: string; count: number }>(
      `SELECT p.source_kind, count(*)::int AS count
         FROM "projection_session" p
        WHERE ${tenantVerifiedProjectionSql('p', 'session')}
        GROUP BY p.source_kind
        ORDER BY count DESC`,
      [ctx.tenantId],
    )
    return {
      counts: counts[0] ?? { sessions: 0, objects: 0, docs: 0, sources: 0 },
      sources: sourceBreakdown.map((row) => ({ sourceKind: row.source_kind, count: row.count })),
    }
  }),

  report: tenantProcedure.input(analyticsReportInput).query(async ({ ctx, input }) => {
    const { whereSql, params } = buildSessionWhere(ctx.tenantId, input)
    const limitParam = appendParam(params, input.limit)

    if (input.report === 'sessions') {
      const rows = await ctx.rawExec<Record<string, unknown>>(
        `SELECT to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_ts,
                p.source_kind AS source_tool,
                p.project_id AS project_name,
                NULL::text AS source_file_path,
                p.id AS session_id,
                p.id AS source_session_id,
                NULL::text AS model_last,
                CASE
                  WHEN p.started_at IS NOT NULL AND p.ended_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (p.ended_at - p.started_at))::int
                  ELSE NULL
                END AS duration_seconds,
                0::int AS message_count,
                0::int AS tool_call_count,
                0::int AS tool_result_count,
                0::int AS tool_error_count,
                NULL::int AS tool_duration_ms,
                NULL::text AS timeline_confidence,
                p.title
           FROM "projection_session" p
          WHERE ${whereSql}
          ORDER BY p.started_at DESC NULLS LAST, p.id DESC
          LIMIT ${limitParam}`,
        params,
      )
      return reportResponse(input, rows)
    }

    if (input.report === 'projects') {
      const rows = await ctx.rawExec<Record<string, unknown>>(
        `SELECT to_char(max(p.started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest_session_ts,
                p.source_kind AS source_tool,
                COALESCE(p.project_id, '(unknown)') AS project_name,
                NULL::text AS project_path,
                count(*)::int AS session_count,
                0::int AS message_count,
                0::int AS tool_call_count,
                0::int AS tool_error_count,
                0::int AS low_confidence_session_count
           FROM "projection_session" p
          WHERE ${whereSql}
          GROUP BY p.source_kind, p.project_id
          ORDER BY max(p.started_at) DESC NULLS LAST, count(*) DESC, project_name ASC
          LIMIT ${limitParam}`,
        params,
      )
      return reportResponse(input, rows)
    }

    return reportResponse(input, [])
  }),
})
