import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { router, tenantProcedure } from '../../init.js'
import { sourceFilter, tenantVerifiedProjectionSql, timeRangeFilter } from './shared.js'

const reportEnum = z.enum(['sessions', 'tools', 'errors', 'models', 'projects'])

const analyticsReportInput = z
  .object({
    report: reportEnum,
    limit: z.number().int().min(1).max(500).default(200),
  })
  .merge(timeRangeFilter)
  .merge(sourceFilter)

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

  /**
   * CQ-006: every analytics.report shape claims parity with the local
   * `session_facts` / `tool_usage_facts` / `error_facts` / `model_usage` /
   * `project_activity` views. The remote projection currently lacks
   * row-level verified manifests for the auxiliary tables those views
   * depend on (CQ-004), AND the `project` table is not in the promotion
   * manifest at all. Rather than emit a reduced shape that drifts from
   * the CLI/local contract, all five remote analytics.report types fail
   * closed with 501 in v0. Callers should use the CLI / local engine
   * until the projection manifest is extended to cover auxiliary rows.
   */
  report: tenantProcedure.input(analyticsReportInput).query(async ({ input }) => {
    throw new TRPCError({
      code: 'NOT_IMPLEMENTED',
      message: `analytics.report "${input.report}" is unavailable in remote v0. The promoted projection lacks the verified auxiliary manifest entries required for parity with the prosa analytics CLI surface. Use the CLI/local engine until the projection schema is extended.`,
    })
  }),
})
