import { z } from 'zod'
import { router, tenantProcedure } from '../init.js'

const limit = z.number().int().min(1).max(500).default(50)

const sessionFilters = z.object({
  sourceKind: z.string().optional(),
  search: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
})

type SessionRow = {
  id: string
  source_kind: string
  title: string | null
  started_at: string | null
  ended_at: string | null
  turn_count: number
  project_id: string | null
}

type ProjectionEntityType = 'source_file' | 'raw_record' | 'session' | 'search_doc'

function buildSessionWhere(
  tenantId: string,
  input: z.infer<typeof sessionFilters>,
): { whereSql: string; params: unknown[] } {
  const clauses = [tenantVerifiedProjectionSql('p', 'session')]
  const params: unknown[] = [tenantId]
  if (input.sourceKind) {
    params.push(input.sourceKind)
    clauses.push(`p.source_kind = $${params.length}`)
  }
  if (input.search) {
    params.push(`%${input.search}%`)
    clauses.push(`p.title ILIKE $${params.length}`)
  }
  if (input.since) {
    params.push(input.since)
    clauses.push(`p.started_at >= $${params.length}`)
  }
  if (input.until) {
    params.push(input.until)
    clauses.push(`p.started_at < $${params.length}`)
  }
  return { whereSql: clauses.join(' AND '), params }
}

function verifiedProjectionExistsSql(alias: string, entityType: ProjectionEntityType): string {
  return `EXISTS (
    SELECT 1
      FROM "sync_batch_projection_manifest" m
      JOIN "sync_batch" b
        ON b.id = m.batch_id
       AND b.tenant_id = m.tenant_id
       AND b.status = 'verified'
     WHERE m.tenant_id = ${alias}.tenant_id
       AND m.entity_type = '${entityType}'
       AND m.entity_id = ${alias}.id
  )`
}

function tenantVerifiedProjectionSql(alias: string, entityType: ProjectionEntityType, tenantParam = '$1'): string {
  return `${alias}.tenant_id = ${tenantParam} AND ${verifiedProjectionExistsSql(alias, entityType)}`
}

function mapSessionRow(row: SessionRow) {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    turnCount: row.turn_count,
    projectId: row.project_id,
  }
}

function appendLimitParam(params: unknown[], limitValue: number): string {
  params.push(limitValue)
  return `$${params.length}`
}

export const sessionsRouter = router({
  list: tenantProcedure
    .input(
      sessionFilters
        .extend({
          limit,
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const { whereSql, params } = buildSessionWhere(ctx.tenantId, input)
      const limitParam = appendLimitParam(params, input.limit)
      const rows = await ctx.rawExec<SessionRow>(
        `SELECT p.id, p.source_kind, p.title, p.started_at, p.ended_at, p.turn_count, p.project_id
           FROM "projection_session" p
           WHERE ${whereSql}
           ORDER BY COALESCE(p.started_at, '1970-01-01') DESC, p.id DESC
           LIMIT ${limitParam}`,
        params,
      )
      return rows.map(mapSessionRow)
    }),

  count: tenantProcedure.input(sessionFilters.default({})).query(async ({ ctx, input }) => {
    const { whereSql, params } = buildSessionWhere(ctx.tenantId, input)
    const rows = await ctx.rawExec<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM "projection_session" p
         WHERE ${whereSql}`,
      params,
    )
    return { count: rows[0]?.count ?? 0 }
  }),

  get: tenantProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    const rows = await ctx.rawExec<
      {
        metadata: unknown
      } & SessionRow
    >(
      `SELECT p.id, p.source_kind, p.title, p.started_at, p.ended_at, p.turn_count, p.project_id, p.metadata
           FROM "projection_session" p
           WHERE ${tenantVerifiedProjectionSql('p', 'session')}
             AND p.id = $2
           LIMIT 1`,
      [ctx.tenantId, input.id],
    )
    const row = rows[0]
    if (!row) return null
    return {
      ...mapSessionRow(row),
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
      const params: unknown[] = [ctx.tenantId, `%${input.q}%`]
      const limitParam = appendLimitParam(params, input.limit)
      const rows = await ctx.rawExec<{
        id: string
        session_id: string
        kind: string
        body: string
      }>(
        `SELECT d.id, d.session_id, d.kind, d.body
           FROM "search_doc" d
           WHERE ${tenantVerifiedProjectionSql('d', 'search_doc')}
             AND d.body ILIKE $2
           ORDER BY d.indexed_at DESC
           LIMIT ${limitParam}`,
        params,
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
          (
            SELECT count(*)::int
              FROM "projection_session" p
             WHERE ${tenantVerifiedProjectionSql('p', 'session')}
          ) as sessions,
          (
            SELECT count(DISTINCT m.object_id)::int
              FROM "sync_batch_object_manifest" m
              JOIN "sync_batch" b
                ON b.id = m.batch_id
               AND b.tenant_id = m.tenant_id
               AND b.status = 'verified'
             WHERE m.tenant_id = $1
          ) as objects,
          (
            SELECT count(*)::int
              FROM "search_doc" d
             WHERE ${tenantVerifiedProjectionSql('d', 'search_doc')}
          ) as docs,
          (
            SELECT count(distinct p.source_kind)::int
              FROM "projection_session" p
             WHERE ${tenantVerifiedProjectionSql('p', 'session')}
          ) as sources`,
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
})
