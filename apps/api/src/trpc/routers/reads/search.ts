import { z } from 'zod'
import { router, tenantProcedure } from '../../init.js'
import {
  type CursorPage,
  appendParam,
  cursorPageInput,
  decodeCursor,
  encodeCursor,
  sourceFilter,
  tenantVerifiedProjectionSql,
  timeRangeFilter,
} from './shared.js'

const searchInput = cursorPageInput
  .merge(timeRangeFilter)
  .merge(sourceFilter)
  .extend({
    q: z.string().min(1).max(500),
    sessionId: z.string().optional(),
    projectIds: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
    toolNames: z.array(z.string()).optional(),
    canonicalToolTypes: z.array(z.string()).optional(),
    fieldKinds: z.array(z.string()).optional(),
    errorsOnly: z.boolean().optional(),
    mode: z.enum(['plain', 'raw']).default('plain'),
  })

type SearchRow = {
  id: string
  session_id: string
  session_title: string | null
  source_kind: string
  indexed_at: string
  kind: string
  body: string
  rank: number | null
}

function buildSnippet(body: string, q: string): string {
  if (!q) return body.slice(0, 320)
  const idx = body.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return body.slice(0, 320)
  const start = Math.max(0, idx - 64)
  return body.slice(start, start + 320)
}

export const searchRouter = router({
  query: tenantProcedure.input(searchInput).query(async ({ ctx, input }) => {
    const params: unknown[] = [ctx.tenantId]
    const clauses = [tenantVerifiedProjectionSql('d', 'search_doc')]
    // V0 search: ILIKE over body. Filters on source/session/projects/kinds are
    // applied via join against projection_session. Postgres FTS over a stored
    // tsvector is the planned upgrade once a deterministic FTS expression is
    // confirmed across pg + pglite.
    const qParam = appendParam(params, `%${input.q}%`)
    clauses.push(`d.body ILIKE ${qParam}`)

    if (input.sessionId) {
      const param = appendParam(params, input.sessionId)
      clauses.push(`d.session_id = ${param}`)
    }
    if (input.fieldKinds && input.fieldKinds.length > 0) {
      const placeholders = input.fieldKinds.map((kind) => appendParam(params, kind)).join(', ')
      clauses.push(`d.kind IN (${placeholders})`)
    }
    if (input.since) {
      const param = appendParam(params, input.since)
      clauses.push(`d.indexed_at >= ${param}`)
    }
    if (input.until) {
      const param = appendParam(params, input.until)
      clauses.push(`d.indexed_at < ${param}`)
    }
    if (input.sourceKinds && input.sourceKinds.length > 0) {
      const placeholders = input.sourceKinds.map((kind) => appendParam(params, kind)).join(', ')
      clauses.push(`s.source_kind IN (${placeholders})`)
    }
    if (input.projectIds && input.projectIds.length > 0) {
      const placeholders = input.projectIds.map((id) => appendParam(params, id)).join(', ')
      clauses.push(`s.project_id IN (${placeholders})`)
    }

    const cursor = decodeCursor<{ idx: string; id: string }>(input.cursor)
    if (cursor) {
      const idxParam = appendParam(params, cursor.idx)
      const idParam = appendParam(params, cursor.id)
      clauses.push(`(d.indexed_at::text < ${idxParam} OR (d.indexed_at::text = ${idxParam} AND d.id < ${idParam}))`)
    }
    const limit = input.limit + 1
    const limitParam = appendParam(params, limit)
    const rows = await ctx.rawExec<SearchRow>(
      `SELECT d.id, d.session_id, d.kind, d.body, d.indexed_at::text AS indexed_at,
              s.source_kind, s.title AS session_title,
              NULL::float AS rank
         FROM "search_doc" d
         JOIN "projection_session" s
           ON s.tenant_id = d.tenant_id AND s.id = d.session_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY d.indexed_at DESC, d.id DESC
        LIMIT ${limitParam}`,
      params,
    )
    const overflow = rows.length > input.limit
    const window = overflow ? rows.slice(0, input.limit) : rows
    const last = window[window.length - 1]
    const nextCursor =
      overflow && last
        ? encodeCursor({
            idx: last.indexed_at,
            id: last.id,
          })
        : null
    const page: CursorPage<{
      id: string
      sessionId: string
      sessionTitle: string | null
      sourceKind: string
      timestamp: string | null
      role: string | null
      toolName: string | null
      fieldKind: string
      snippet: string
      rank: number | null
    }> = {
      rows: window.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        sourceKind: row.source_kind,
        timestamp: row.indexed_at,
        role: null,
        toolName: null,
        fieldKind: row.kind,
        snippet: buildSnippet(row.body, input.q),
        rank: row.rank,
      })),
      nextCursor,
    }
    return page
  }),
})
