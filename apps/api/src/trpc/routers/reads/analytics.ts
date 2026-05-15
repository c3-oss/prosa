import { TRPCError } from '@trpc/server'
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

/**
 * CQ-006: rename snake_case projection columns to camelCase for web/API
 * consumers. The remaining `sessions` and `projects` reports keep the
 * existing semantics (rows + columns match the prosa analytics CLI surface)
 * but the keys are stable JS-friendly identifiers.
 */
function camelize<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    const next = key.replace(/_([a-z])/g, (_match, ch: string) => ch.toUpperCase())
    out[next] = value
  }
  return out
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

    // CQ-004 + CQ-006: tools / errors / models reports join auxiliary
    // projection tables (`projection_tool_call`, `projection_tool_result`,
    // `projection_message`) whose rows have no row-level verified
    // provenance in v0. Until the promotion manifest grows those entity
    // types, those three reports fail closed so the API never surfaces
    // unverified auxiliary rows. The `sessions` and `projects` reports
    // continue to operate against the verified-projection-gated
    // `projection_session` rows only.
    if (input.report === 'tools' || input.report === 'errors' || input.report === 'models') {
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: `analytics.report "${input.report}" requires verified auxiliary projection rows. Remote v0 fails closed; use the CLI/local analytics until promotion-manifest entity types are extended.`,
      })
    }

    const params: unknown[] = [ctx.tenantId]
    const filter = applyTimeAndSource('p', params, input)
    const limitParam = appendParam(params, input.limit)

    if (input.report === 'sessions') {
      const rows = await ctx.rawExec<Record<string, unknown>>(
        `SELECT p.id AS session_id,
                p.source_kind,
                p.project_id,
                p.title,
                to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
                to_char(p.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_at,
                CASE WHEN p.started_at IS NULL OR p.ended_at IS NULL THEN NULL
                     ELSE (EXTRACT(EPOCH FROM (p.ended_at - p.started_at)) * 1000)::int
                END AS duration_ms,
                p.turn_count
           FROM "projection_session" p
          WHERE ${tenantVerifiedProjectionSql('p', 'session')}${filter}
          ORDER BY p.started_at DESC NULLS LAST, p.id DESC
          LIMIT ${limitParam}`,
        params,
      )
      return { report: 'sessions', rows: rows.map(camelize), generatedAt }
    }

    // input.report === 'projects'
    const rows = await ctx.rawExec<Record<string, unknown>>(
      `SELECT COALESCE(pr.id, p.project_id, 'unassigned') AS project_id,
              COALESCE(pr.name, p.project_id, 'unassigned') AS project_name,
              count(p.id)::int AS session_count,
              to_char(max(p.started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest_session_at
         FROM "projection_session" p
    LEFT JOIN "project" pr
           ON pr.tenant_id = p.tenant_id AND pr.id = p.project_id
        WHERE ${tenantVerifiedProjectionSql('p', 'session')}${filter}
        GROUP BY 1, 2
        ORDER BY session_count DESC, project_name ASC
        LIMIT ${limitParam}`,
      params,
    )
    return { report: 'projects', rows: rows.map(camelize), generatedAt }
  }),
})
