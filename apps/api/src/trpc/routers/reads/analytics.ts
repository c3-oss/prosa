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

function applyTimeAndSource(
  alias: string,
  params: unknown[],
  input: { since?: string; until?: string; sourceKinds?: string[] | undefined },
): string {
  const clauses: string[] = []
  if (input.since) {
    const param = appendParam(params, input.since)
    clauses.push(`${alias}.started_at >= ${param}`)
  }
  if (input.until) {
    const param = appendParam(params, input.until)
    clauses.push(`${alias}.started_at < ${param}`)
  }
  if (input.sourceKinds && input.sourceKinds.length > 0) {
    const placeholders = input.sourceKinds.map((k) => appendParam(params, k)).join(', ')
    clauses.push(`${alias}.source_kind IN (${placeholders})`)
  }
  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
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
    const generatedAt = new Date().toISOString()
    const params: unknown[] = [ctx.tenantId]
    const filter = applyTimeAndSource('p', params, input)
    const limitParam = appendParam(params, input.limit)

    switch (input.report) {
      case 'sessions': {
        const rows = await ctx.rawExec<Record<string, unknown>>(
          `SELECT p.id AS session_id,
                  p.source_kind,
                  p.project_id,
                  p.title,
                  p.started_at,
                  p.ended_at,
                  EXTRACT(EPOCH FROM (p.ended_at - p.started_at)) * 1000 AS duration_ms,
                  (SELECT count(*)::int FROM "projection_message" m WHERE m.tenant_id = p.tenant_id AND m.session_id = p.id) AS message_count,
                  (SELECT count(*)::int FROM "projection_tool_call" t WHERE t.tenant_id = p.tenant_id AND t.session_id = p.id) AS tool_call_count
             FROM "projection_session" p
            WHERE ${tenantVerifiedProjectionSql('p', 'session')}${filter}
            ORDER BY p.started_at DESC NULLS LAST, p.id DESC
            LIMIT ${limitParam}`,
          params,
        )
        return { report: 'sessions', rows, generatedAt }
      }
      case 'tools': {
        const rows = await ctx.rawExec<Record<string, unknown>>(
          `SELECT t.name AS tool_name,
                  count(*)::int AS call_count,
                  count(*) FILTER (WHERE r.status IS NOT NULL AND r.status NOT IN ('ok','success','completed'))::int AS error_count,
                  count(DISTINCT t.session_id)::int AS session_count
             FROM "projection_tool_call" t
             JOIN "projection_session" p
               ON p.tenant_id = t.tenant_id AND p.id = t.session_id
        LEFT JOIN "projection_tool_result" r
               ON r.tenant_id = t.tenant_id AND r.tool_call_id = t.id
            WHERE t.tenant_id = $1 AND ${tenantVerifiedProjectionSql('p', 'session')}${filter}
            GROUP BY t.name
            ORDER BY call_count DESC, tool_name ASC
            LIMIT ${limitParam}`,
          params,
        )
        return { report: 'tools', rows, generatedAt }
      }
      case 'errors': {
        const rows = await ctx.rawExec<Record<string, unknown>>(
          `SELECT t.session_id,
                  t.id AS tool_call_id,
                  t.name AS tool_name,
                  r.status AS result_status,
                  r.finished_at,
                  p.source_kind,
                  p.title AS session_title
             FROM "projection_tool_result" r
             JOIN "projection_tool_call" t
               ON t.tenant_id = r.tenant_id AND t.id = r.tool_call_id
             JOIN "projection_session" p
               ON p.tenant_id = t.tenant_id AND p.id = t.session_id
            WHERE r.tenant_id = $1
              AND r.status IS NOT NULL AND r.status NOT IN ('ok','success','completed')
              AND ${tenantVerifiedProjectionSql('p', 'session')}${filter}
            ORDER BY r.finished_at DESC NULLS LAST, r.tool_call_id DESC
            LIMIT ${limitParam}`,
          params,
        )
        return { report: 'errors', rows, generatedAt }
      }
      case 'models': {
        const rows = await ctx.rawExec<Record<string, unknown>>(
          `SELECT COALESCE(m.model, 'unknown') AS model,
                  count(*)::int AS message_count,
                  count(DISTINCT m.session_id)::int AS session_count
             FROM "projection_message" m
             JOIN "projection_session" p
               ON p.tenant_id = m.tenant_id AND p.id = m.session_id
            WHERE m.tenant_id = $1
              AND ${tenantVerifiedProjectionSql('p', 'session')}${filter}
            GROUP BY model
            ORDER BY message_count DESC, model ASC
            LIMIT ${limitParam}`,
          params,
        )
        return { report: 'models', rows, generatedAt }
      }
      case 'projects': {
        const rows = await ctx.rawExec<Record<string, unknown>>(
          `SELECT COALESCE(pr.id, p.project_id, 'unassigned') AS project_id,
                  COALESCE(pr.name, p.project_id, 'unassigned') AS project_name,
                  count(p.id)::int AS session_count,
                  max(p.started_at) AS latest_session_at
             FROM "projection_session" p
        LEFT JOIN "project" pr
               ON pr.tenant_id = p.tenant_id AND pr.id = p.project_id
            WHERE ${tenantVerifiedProjectionSql('p', 'session')}${filter}
            GROUP BY 1, 2
            ORDER BY session_count DESC, project_name ASC
            LIMIT ${limitParam}`,
          params,
        )
        return { report: 'projects', rows, generatedAt }
      }
    }
  }),
})
