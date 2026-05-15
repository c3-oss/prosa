import { z } from 'zod'
import { router, tenantProcedure } from '../../init.js'
import {
  type CursorPage,
  appendParam,
  cursorPageInput,
  decodeCursor,
  encodeCursor,
  eventCursorPageInput,
  sourceFilter,
  tenantVerifiedProjectionSql,
  timeRangeFilter,
} from './shared.js'

const sessionsListFilters = z.object({
  projectIds: z.array(z.string()).optional(),
  q: z.string().optional(),
  model: z.string().optional(),
  hasErrors: z.boolean().optional(),
  sort: z.enum(['startedAtDesc', 'startedAtAsc']).default('startedAtDesc'),
})

const sessionsListInput = cursorPageInput.merge(timeRangeFilter).merge(sourceFilter).merge(sessionsListFilters)
const sessionsCountInput = timeRangeFilter.merge(sourceFilter).merge(sessionsListFilters.omit({ sort: true }))

type SessionRow = {
  id: string
  source_kind: string
  title: string | null
  started_at: string | null
  ended_at: string | null
  turn_count: number
  project_id: string | null
  message_count: number
  tool_call_count: number
  error_count: number
}

function buildSessionWhere(
  tenantId: string,
  input: z.infer<typeof sessionsListInput> | z.infer<typeof sessionsCountInput>,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [tenantId]
  const clauses: string[] = [tenantVerifiedProjectionSql('p', 'session')]
  if (input.sourceKinds && input.sourceKinds.length > 0) {
    const placeholders = input.sourceKinds.map((kind) => appendParam(params, kind)).join(', ')
    clauses.push(`p.source_kind IN (${placeholders})`)
  }
  if (input.q) {
    const param = appendParam(params, `%${input.q}%`)
    clauses.push(`p.title ILIKE ${param}`)
  }
  if (input.since) {
    const param = appendParam(params, input.since)
    clauses.push(`p.started_at >= ${param}`)
  }
  if (input.until) {
    const param = appendParam(params, input.until)
    clauses.push(`p.started_at < ${param}`)
  }
  if (input.projectIds && input.projectIds.length > 0) {
    const placeholders = input.projectIds.map((id) => appendParam(params, id)).join(', ')
    clauses.push(`p.project_id IN (${placeholders})`)
  }
  if (input.model) {
    const param = appendParam(params, input.model)
    clauses.push(
      `EXISTS (SELECT 1 FROM "projection_message" pm WHERE pm.tenant_id = p.tenant_id AND pm.session_id = p.id AND pm.model = ${param})`,
    )
  }
  return { whereSql: clauses.join(' AND '), params }
}

function mapSessionRow(row: SessionRow) {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs:
      row.started_at && row.ended_at ? Math.max(0, Date.parse(row.ended_at) - Date.parse(row.started_at)) : null,
    projectId: row.project_id,
    turnCount: row.turn_count,
    messageCount: row.message_count,
    toolCallCount: row.tool_call_count,
    errorCount: row.error_count,
  }
}

type SessionsListCursor = { s: string | null; id: string }

const baseRowColumns = `p.id, p.source_kind, p.title,
   to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
   to_char(p.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_at,
   p.turn_count, p.project_id,
   (SELECT count(*)::int FROM "projection_message" m WHERE m.tenant_id = p.tenant_id AND m.session_id = p.id) AS message_count,
   (SELECT count(*)::int FROM "projection_tool_call" t WHERE t.tenant_id = p.tenant_id AND t.session_id = p.id) AS tool_call_count,
   (SELECT count(*)::int FROM "projection_tool_result" r
      JOIN "projection_tool_call" t ON t.tenant_id = r.tenant_id AND t.id = r.tool_call_id
      WHERE r.tenant_id = p.tenant_id AND t.session_id = p.id AND r.status IS NOT NULL AND r.status NOT IN ('ok','success','completed')) AS error_count`

export const sessionsRouter = router({
  list: tenantProcedure.input(sessionsListInput.default({})).query(async ({ ctx, input }) => {
    const { whereSql, params } = buildSessionWhere(ctx.tenantId, input)
    const order = input.sort === 'startedAtAsc' ? 'ASC' : 'DESC'
    const cursor = decodeCursor<SessionsListCursor>(input.cursor)
    let cursorClause = ''
    if (cursor) {
      // The cursor encodes the started_at as ISO 8601. Compare against the
      // same formatted timestamp so the cursor is stable regardless of the
      // server's display format for `timestamptz`.
      const startedExpr = `COALESCE(to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')`
      const startedParam = appendParam(params, cursor.s ?? '')
      const idParam = appendParam(params, cursor.id)
      if (order === 'DESC') {
        cursorClause = ` AND (${startedExpr} < ${startedParam} OR (${startedExpr} = ${startedParam} AND p.id < ${idParam}))`
      } else {
        cursorClause = ` AND (${startedExpr} > ${startedParam} OR (${startedExpr} = ${startedParam} AND p.id > ${idParam}))`
      }
    }
    const limit = input.limit + 1
    const limitParam = appendParam(params, limit)
    const rows = await ctx.rawExec<SessionRow>(
      `SELECT ${baseRowColumns}
         FROM "projection_session" p
        WHERE ${whereSql}${cursorClause}
        ORDER BY COALESCE(p.started_at, '1970-01-01') ${order}, p.id ${order}
        LIMIT ${limitParam}`,
      params,
    )
    const overflow = rows.length > input.limit
    const window = overflow ? rows.slice(0, input.limit) : rows
    const last = window[window.length - 1]
    const nextCursor =
      overflow && last
        ? encodeCursor({
            s: last.started_at ?? '',
            id: last.id,
          })
        : null
    const page: CursorPage<ReturnType<typeof mapSessionRow>> = {
      rows: window.map(mapSessionRow),
      nextCursor,
    }
    return page
  }),

  count: tenantProcedure.input(sessionsCountInput.default({})).query(async ({ ctx, input }) => {
    const { whereSql, params } = buildSessionWhere(ctx.tenantId, input)
    const rows = await ctx.rawExec<{ count: number }>(
      `SELECT count(*)::int AS count FROM "projection_session" p WHERE ${whereSql}`,
      params,
    )
    return { count: rows[0]?.count ?? 0 }
  }),

  detail: tenantProcedure
    .input(eventCursorPageInput.extend({ sessionId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const sessionRows = await ctx.rawExec<
        SessionRow & {
          metadata: unknown
        }
      >(
        `SELECT ${baseRowColumns}, p.metadata
            FROM "projection_session" p
           WHERE ${tenantVerifiedProjectionSql('p', 'session')} AND p.id = $2
           LIMIT 1`,
        [ctx.tenantId, input.sessionId],
      )
      const session = sessionRows[0]
      if (!session) return null
      const cursor = decodeCursor<{ seq: number; id: string }>(input.cursor)
      const eventParams: unknown[] = [ctx.tenantId, input.sessionId]
      let cursorClause = ''
      if (cursor) {
        const seqParam = appendParam(eventParams, cursor.seq)
        const idParam = appendParam(eventParams, cursor.id)
        cursorClause = ` AND (e.sequence > ${seqParam} OR (e.sequence = ${seqParam} AND e.id > ${idParam}))`
      }
      const limit = input.limit + 1
      const limitParam = appendParam(eventParams, limit)
      const events = await ctx.rawExec<{
        id: string
        sequence: number
        kind: string
        payload: unknown
        occurred_at: string | null
      }>(
        `SELECT e.id, e.sequence, e.kind, e.payload, e.occurred_at
           FROM "projection_event" e
          WHERE e.tenant_id = $1 AND e.session_id = $2${cursorClause}
          ORDER BY e.sequence ASC, e.id ASC
          LIMIT ${limitParam}`,
        eventParams,
      )
      const overflow = events.length > input.limit
      const window = overflow ? events.slice(0, input.limit) : events
      const last = window[window.length - 1]
      const eventCursor = overflow && last ? encodeCursor({ seq: last.sequence, id: last.id }) : null

      const artifacts = await ctx.rawExec<{
        id: string
        kind: string
        object_id: string | null
        size_bytes: string | null
      }>(
        `SELECT a.id, a.kind, a.object_id, a.size_bytes::text AS size_bytes
           FROM "projection_artifact" a
          WHERE a.tenant_id = $1 AND a.session_id = $2
          ORDER BY a.id ASC
          LIMIT 200`,
        [ctx.tenantId, input.sessionId],
      )

      return {
        session: {
          ...mapSessionRow(session),
          metadata: session.metadata,
        },
        events: {
          rows: window.map((ev) => ({
            id: ev.id,
            ordinal: ev.sequence,
            timestamp: ev.occurred_at,
            kind: ev.kind,
            payload: ev.payload,
          })),
          nextCursor: eventCursor,
        },
        relatedArtifacts: artifacts.map((a) => ({
          id: a.id,
          kind: a.kind,
          objectId: a.object_id,
          sizeBytes: a.size_bytes == null ? null : Number.parseInt(a.size_bytes, 10),
        })),
      }
    }),

  /** Legacy `sessions.get` alias kept for the existing CLI/MCP consumers. */
  get: tenantProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    const rows = await ctx.rawExec<SessionRow & { metadata: unknown }>(
      `SELECT ${baseRowColumns}, p.metadata
          FROM "projection_session" p
         WHERE ${tenantVerifiedProjectionSql('p', 'session')} AND p.id = $2
         LIMIT 1`,
      [ctx.tenantId, input.id],
    )
    const row = rows[0]
    if (!row) return null
    return { ...mapSessionRow(row), metadata: row.metadata }
  }),
})
