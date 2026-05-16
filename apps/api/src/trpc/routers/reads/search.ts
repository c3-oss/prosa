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
  kind: string
  body: string
  session_title: string | null
  source_kind: string
  timestamp: string | null
}

type SearchCursor = { t: string; id: string }

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function hasUnsupportedSearchFilters(input: z.infer<typeof searchInput>): boolean {
  return Boolean(
    (input.roles && input.roles.length > 0) ||
      (input.toolNames && input.toolNames.length > 0) ||
      (input.canonicalToolTypes && input.canonicalToolTypes.length > 0) ||
      input.errorsOnly,
  )
}

function buildSnippet(body: string, query: string): string {
  const compact = body.replace(/\s+/g, ' ').trim()
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return compact.slice(0, 240)
  const index = compact.toLocaleLowerCase().indexOf(needle)
  if (index < 0) return compact.slice(0, 240)
  const start = Math.max(0, index - 80)
  const end = Math.min(compact.length, index + needle.length + 160)
  return `${start > 0 ? '...' : ''}${compact.slice(start, end)}${end < compact.length ? '...' : ''}`
}

function buildSearchWhere(
  tenantId: string,
  input: z.infer<typeof searchInput>,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [tenantId]
  const clauses = [tenantVerifiedProjectionSql('d', 'search_doc'), tenantVerifiedProjectionSql('p', 'session')]
  const q = input.q.trim()
  const pattern = appendParam(params, `%${escapeLike(q)}%`)
  clauses.push(`(d.body ILIKE ${pattern} ESCAPE '\\' OR d.kind ILIKE ${pattern} ESCAPE '\\')`)
  if (input.sessionId) {
    const param = appendParam(params, input.sessionId)
    clauses.push(`d.session_id = ${param}`)
  }
  if (input.projectIds && input.projectIds.length > 0) {
    const placeholders = input.projectIds.map((id) => appendParam(params, id)).join(', ')
    clauses.push(`p.project_id IN (${placeholders})`)
  }
  if (input.sourceKinds && input.sourceKinds.length > 0) {
    const placeholders = input.sourceKinds.map((kind) => appendParam(params, kind)).join(', ')
    clauses.push(`p.source_kind IN (${placeholders})`)
  }
  if (input.fieldKinds && input.fieldKinds.length > 0) {
    const placeholders = input.fieldKinds.map((kind) => appendParam(params, kind)).join(', ')
    clauses.push(`d.kind IN (${placeholders})`)
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

function mapSearchRow(row: SearchRow, query: string) {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    sourceKind: row.source_kind,
    timestamp: row.timestamp,
    role: null,
    toolName: null,
    fieldKind: row.kind,
    snippet: buildSnippet(row.body, query),
    rank: null,
  }
}

export const searchRouter = router({
  query: tenantProcedure.input(searchInput).query(async ({ ctx, input }) => {
    if (hasUnsupportedSearchFilters(input)) {
      return { rows: [], nextCursor: null } satisfies CursorPage<ReturnType<typeof mapSearchRow>>
    }

    const { whereSql, params } = buildSearchWhere(ctx.tenantId, input)
    const cursor = decodeCursor<SearchCursor>(input.cursor)
    let cursorClause = ''
    if (cursor) {
      const timestampExpr = `COALESCE(to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')`
      const timestampParam = appendParam(params, cursor.t)
      const idParam = appendParam(params, cursor.id)
      cursorClause = ` AND (${timestampExpr} < ${timestampParam} OR (${timestampExpr} = ${timestampParam} AND d.id < ${idParam}))`
    }

    const limit = input.limit + 1
    const limitParam = appendParam(params, limit)
    const rows = await ctx.rawExec<SearchRow>(
      `SELECT d.id,
              d.session_id,
              d.kind,
              d.body,
              p.title AS session_title,
              p.source_kind,
              to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp
         FROM "search_doc" d
         JOIN "projection_session" p ON p.tenant_id = d.tenant_id AND p.id = d.session_id
        WHERE ${whereSql}${cursorClause}
        ORDER BY COALESCE(p.started_at, '1970-01-01') DESC, d.id DESC
        LIMIT ${limitParam}`,
      params,
    )
    const overflow = rows.length > input.limit
    const window = overflow ? rows.slice(0, input.limit) : rows
    const last = window[window.length - 1]
    return {
      rows: window.map((row) => mapSearchRow(row, input.q)),
      nextCursor: overflow && last ? encodeCursor({ t: last.timestamp ?? '', id: last.id }) : null,
    } satisfies CursorPage<ReturnType<typeof mapSearchRow>>
  }),
})
