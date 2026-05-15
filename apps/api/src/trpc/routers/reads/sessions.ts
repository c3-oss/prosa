import { TRPCError } from '@trpc/server'
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

function rejectUnverifiedAuxiliaryFilters(input: { model?: string; hasErrors?: boolean }): void {
  // CQ-004: `model` and `hasErrors` would have to join against the unverified
  // auxiliary projection tables (projection_message / projection_tool_result).
  // The promotion manifest does not carry row-level verification for those
  // tables in v0, so applying these filters would let directly-inserted rows
  // change which sessions appear or how many. Fail closed instead.
  if (input.model) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'sessions filter "model" is not supported by remote v0 (projection_message has no row-level verified manifest). Use the CLI/local engine.',
    })
  }
  if (input.hasErrors !== undefined) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'sessions filter "hasErrors" is not supported by remote v0 (projection_tool_result has no row-level verified manifest). Use the CLI/local engine.',
    })
  }
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

// CQ-004: auxiliary projection rows (message, tool_call, tool_result, event,
// artifact) currently have no row-level verified manifest entries — the
// promotion manifest only covers `session` and `search_doc`. Until that
// expansion lands, count subqueries against those tables would surface
// directly-inserted-but-unverified data attached to a verified session.
// We therefore report 0 here. Per-row reads (sessions.detail.events,
// toolCalls.list) do the same fail-closed.
const baseRowColumns = `p.id, p.source_kind, p.title,
   to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
   to_char(p.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_at,
   p.turn_count, p.project_id,
   0::int AS message_count,
   0::int AS tool_call_count,
   0::int AS error_count`

export const sessionsRouter = router({
  list: tenantProcedure.input(sessionsListInput.default({})).query(async ({ ctx, input }) => {
    rejectUnverifiedAuxiliaryFilters(input)
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
    rejectUnverifiedAuxiliaryFilters(input)
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
      // CQ-004: projection_event / projection_artifact have no row-level
      // verified-manifest entries in v0. Returning auxiliary rows that were
      // attached to a verified session would surface unverified data. Until
      // the promotion manifest grows entity_types for those rows, return
      // empty pages with an explicit `auxiliaryRowsAvailable: false` flag.
      void input.cursor
      return {
        session: {
          ...mapSessionRow(session),
          metadata: session.metadata,
        },
        events: { rows: [], nextCursor: null },
        relatedArtifacts: [],
        auxiliaryRowsAvailable: false as const,
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
