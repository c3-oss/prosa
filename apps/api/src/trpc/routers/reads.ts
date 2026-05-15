import { z } from 'zod'
import { router, tenantProcedure } from '../init.js'

const limit = z.number().int().min(1).max(500).default(50)

export const sessionsRouter = router({
  list: tenantProcedure
    .input(
      z
        .object({
          limit,
          sourceKind: z.string().optional(),
          search: z.string().optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const sourceFilter = input.sourceKind ? 'AND source_kind = $2' : ''
      const titleFilter = input.search ? `AND title ILIKE $${input.sourceKind ? 3 : 2}` : ''
      const params: unknown[] = [ctx.tenantId]
      if (input.sourceKind) params.push(input.sourceKind)
      if (input.search) params.push(`%${input.search}%`)
      const rows = await ctx.rawExec<{
        id: string
        source_kind: string
        title: string | null
        started_at: string | null
        ended_at: string | null
        turn_count: number
        project_id: string | null
      }>(
        `SELECT id, source_kind, title, started_at, ended_at, turn_count, project_id
           FROM "projection_session"
           WHERE tenant_id = $1 ${sourceFilter} ${titleFilter}
           ORDER BY COALESCE(started_at, '1970-01-01') DESC, id DESC
           LIMIT ${input.limit}`,
        params,
      )
      return rows.map((row) => ({
        id: row.id,
        sourceKind: row.source_kind,
        title: row.title,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        turnCount: row.turn_count,
        projectId: row.project_id,
      }))
    }),

  get: tenantProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    const rows = await ctx.rawExec<{
      id: string
      source_kind: string
      title: string | null
      started_at: string | null
      ended_at: string | null
      turn_count: number
      project_id: string | null
      metadata: unknown
    }>(
      `SELECT id, source_kind, title, started_at, ended_at, turn_count, project_id, metadata
           FROM "projection_session"
           WHERE tenant_id = $1 AND id = $2
           LIMIT 1`,
      [ctx.tenantId, input.id],
    )
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      sourceKind: row.source_kind,
      title: row.title,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      turnCount: row.turn_count,
      projectId: row.project_id,
      metadata: row.metadata,
    }
  }),
})

export const searchRouter = router({
  query: tenantProcedure
    .input(
      z.object({
        q: z.string().min(1).max(500),
        limit,
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.rawExec<{
        id: string
        session_id: string
        kind: string
        body: string
      }>(
        `SELECT id, session_id, kind, body
           FROM "search_doc"
           WHERE tenant_id = $1
             AND body ILIKE $2
           ORDER BY indexed_at DESC
           LIMIT ${input.limit}`,
        [ctx.tenantId, `%${input.q}%`],
      )
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        kind: row.kind,
        snippet: row.body.slice(0, 320),
      }))
    }),
})

export const analyticsRouter = router({
  summary: tenantProcedure.query(async ({ ctx }) => {
    const counts = await ctx.rawExec<{
      sessions: number
      objects: number
      docs: number
      sources: number
    }>(
      `SELECT
          (SELECT count(*)::int FROM "projection_session" WHERE tenant_id = $1) as sessions,
          (SELECT count(*)::int FROM "tenant_object" WHERE tenant_id = $1) as objects,
          (SELECT count(*)::int FROM "search_doc" WHERE tenant_id = $1) as docs,
          (SELECT count(distinct source_kind)::int FROM "projection_session" WHERE tenant_id = $1) as sources`,
      [ctx.tenantId],
    )
    const sourceBreakdown = await ctx.rawExec<{ source_kind: string; count: number }>(
      `SELECT source_kind, count(*)::int AS count
         FROM "projection_session"
         WHERE tenant_id = $1
         GROUP BY source_kind
         ORDER BY count DESC`,
      [ctx.tenantId],
    )
    return {
      counts: counts[0] ?? { sessions: 0, objects: 0, docs: 0, sources: 0 },
      sources: sourceBreakdown.map((row) => ({ sourceKind: row.source_kind, count: row.count })),
    }
  }),
})
