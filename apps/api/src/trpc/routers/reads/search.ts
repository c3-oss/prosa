import { TRPCError } from '@trpc/server'
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
    // Lane 04 spec includes role/tool/canonical-tool/errors-only filters and a
    // raw mode. The remote search_doc projection v0 stores only
    // `{kind, body, session_id, indexed_at}`, so until role/tool columns are
    // promoted we fail closed when those filters are requested.
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
  indexed_at_iso: string
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
    // CQ-005: fail closed when filters the projection cannot enforce are
    // requested. Silently ignoring them would let the caller believe the
    // results are scoped.
    if (input.roles && input.roles.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'roles filter is not supported by remote search v0 (projection schema lacks a role column).',
      })
    }
    if (input.toolNames && input.toolNames.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'toolNames filter is not supported by remote search v0.',
      })
    }
    if (input.canonicalToolTypes && input.canonicalToolTypes.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'canonicalToolTypes filter is not supported by remote search v0.',
      })
    }
    if (input.errorsOnly) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'errorsOnly filter is not supported by remote search v0.',
      })
    }
    if (input.mode === 'raw') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'mode="raw" is not supported by remote search v0; query inputs are escaped automatically.',
      })
    }

    const params: unknown[] = [ctx.tenantId]
    const clauses = [tenantVerifiedProjectionSql('d', 'search_doc')]
    // V0 search: parameterised ILIKE over `body`. Postgres FTS upgrade is
    // tracked separately; for now we explicitly escape the LIKE wildcards
    // in the user query so a literal `%` or `_` doesn't widen the match.
    const escaped = input.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    const qParam = appendParam(params, `%${escaped}%`)
    clauses.push(`d.body ILIKE ${qParam} ESCAPE '\\'`)

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

    const indexedAtIso = `COALESCE(to_char(d.indexed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')`
    const cursor = decodeCursor<{ idx: string; id: string }>(input.cursor)
    if (cursor) {
      const idxParam = appendParam(params, cursor.idx ?? '')
      const idParam = appendParam(params, cursor.id)
      clauses.push(`(${indexedAtIso} < ${idxParam} OR (${indexedAtIso} = ${idxParam} AND d.id < ${idParam}))`)
    }
    const limit = input.limit + 1
    const limitParam = appendParam(params, limit)
    const rows = await ctx.rawExec<SearchRow>(
      `SELECT d.id,
              d.session_id,
              d.kind,
              d.body,
              ${indexedAtIso} AS indexed_at_iso,
              s.source_kind,
              s.title AS session_title,
              NULL::float AS rank
         FROM "search_doc" d
         JOIN "projection_session" s
           ON s.tenant_id = d.tenant_id AND s.id = d.session_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY ${indexedAtIso} DESC, d.id DESC
        LIMIT ${limitParam}`,
      params,
    )
    const overflow = rows.length > input.limit
    const window = overflow ? rows.slice(0, input.limit) : rows
    const last = window[window.length - 1]
    const nextCursor =
      overflow && last
        ? encodeCursor({
            idx: last.indexed_at_iso,
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
        timestamp: row.indexed_at_iso,
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
