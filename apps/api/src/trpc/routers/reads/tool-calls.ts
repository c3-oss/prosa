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
  verifiedProjectionExistsSql,
} from './shared.js'

const toolCallsListInput = cursorPageInput
  .merge(timeRangeFilter)
  .merge(sourceFilter)
  .extend({
    sessionId: z.string().optional(),
    toolNames: z.array(z.string()).optional(),
    canonicalToolTypes: z.array(z.string()).optional(),
    statuses: z.array(z.string()).optional(),
    errorsOnly: z.boolean().optional(),
    pathSubstring: z.string().optional(),
  })

type ToolCallsInput = z.infer<typeof toolCallsListInput>

type ToolCallRow = {
  id: string
  session_id: string
  session_title: string | null
  source_kind: string
  name: string
  status: string | null
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  result_status: string | null
  cursor_ts: string | null
}

type ToolCallCursor = { t: string; id: string }

function rejectUnsupportedToolCallFilters(input: ToolCallsInput): void {
  if (input.canonicalToolTypes && input.canonicalToolTypes.length > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'canonicalToolTypes filter is not supported by the remote projection v0.',
    })
  }
  if (input.pathSubstring) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'pathSubstring filter is not supported by the remote projection v0.',
    })
  }
}

function buildToolCallsWhere(tenantId: string, input: ToolCallsInput): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [tenantId]
  const clauses = [
    'c.tenant_id = $1',
    'p.tenant_id = c.tenant_id',
    'p.id = c.session_id',
    tenantVerifiedProjectionSql('p', 'session'),
    verifiedProjectionExistsSql('c', 'tool_call'),
  ]
  const timeExpr = 'COALESCE(c.created_at, p.started_at)'

  if (input.sessionId) {
    const param = appendParam(params, input.sessionId)
    clauses.push(`c.session_id = ${param}`)
  }
  if (input.toolNames && input.toolNames.length > 0) {
    const placeholders = input.toolNames.map((name) => appendParam(params, name)).join(', ')
    clauses.push(`c.name IN (${placeholders})`)
  }
  if (input.statuses && input.statuses.length > 0) {
    const placeholders = input.statuses.map((status) => appendParam(params, status)).join(', ')
    clauses.push(`c.status IN (${placeholders})`)
  }
  if (input.sourceKinds && input.sourceKinds.length > 0) {
    const placeholders = input.sourceKinds.map((kind) => appendParam(params, kind)).join(', ')
    clauses.push(`p.source_kind IN (${placeholders})`)
  }
  if (input.since) {
    const param = appendParam(params, input.since)
    clauses.push(`${timeExpr} >= ${param}`)
  }
  if (input.until) {
    const param = appendParam(params, input.until)
    clauses.push(`${timeExpr} < ${param}`)
  }
  if (input.errorsOnly) {
    clauses.push(`(
      lower(COALESCE(c.status, '')) IN ('error', 'failed', 'failure')
      OR (
        r.status IS NOT NULL
        AND lower(r.status) NOT IN ('ok', 'success', 'completed')
      )
    )`)
  }

  return { whereSql: clauses.join(' AND '), params }
}

function mapToolCallRow(row: ToolCallRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    sourceKind: row.source_kind,
    name: row.name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    resultStatus: row.result_status,
  }
}

export const toolCallsRouter = router({
  list: tenantProcedure.input(toolCallsListInput.default({})).query(async ({ ctx, input }) => {
    rejectUnsupportedToolCallFilters(input)
    const { whereSql, params } = buildToolCallsWhere(ctx.tenantId, input)
    const cursor = decodeCursor<ToolCallCursor>(input.cursor)
    const sortExpr = `COALESCE(to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')`
    let cursorClause = ''
    if (cursor) {
      const timestampParam = appendParam(params, cursor.t)
      const idParam = appendParam(params, cursor.id)
      cursorClause = ` AND (${sortExpr} < ${timestampParam} OR (${sortExpr} = ${timestampParam} AND c.id < ${idParam}))`
    }

    const limit = input.limit + 1
    const limitParam = appendParam(params, limit)
    const rows = await ctx.rawExec<ToolCallRow>(
      `SELECT c.id,
              c.session_id,
              p.title AS session_title,
              p.source_kind,
              c.name,
              c.status,
              to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
              to_char(r.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at,
              CASE
                WHEN c.created_at IS NOT NULL AND r.finished_at IS NOT NULL
                  THEN GREATEST(0, (EXTRACT(EPOCH FROM (r.finished_at - c.created_at)) * 1000)::int)
                ELSE NULL
              END AS duration_ms,
              r.status AS result_status,
              ${sortExpr} AS cursor_ts
         FROM "projection_tool_call" c
         JOIN "projection_session" p ON p.tenant_id = c.tenant_id AND p.id = c.session_id
         LEFT JOIN LATERAL (
           SELECT tr.status, tr.finished_at
             FROM "projection_tool_result" tr
            WHERE tr.tenant_id = c.tenant_id
              AND tr.tool_call_id = c.id
              AND ${verifiedProjectionExistsSql('tr', 'tool_result')}
            ORDER BY tr.finished_at DESC NULLS LAST, tr.id DESC
            LIMIT 1
         ) r ON TRUE
        WHERE ${whereSql}${cursorClause}
        ORDER BY COALESCE(c.created_at, p.started_at, '1970-01-01') DESC, c.id DESC
        LIMIT ${limitParam}`,
      params,
    )
    const overflow = rows.length > input.limit
    const window = overflow ? rows.slice(0, input.limit) : rows
    const last = window[window.length - 1]
    const page: CursorPage<ReturnType<typeof mapToolCallRow>> & { verifiedAuxiliaryAvailable: true } = {
      rows: window.map(mapToolCallRow),
      nextCursor: overflow && last ? encodeCursor({ t: last.cursor_ts ?? '', id: last.id }) : null,
      verifiedAuxiliaryAvailable: true,
    }
    return page
  }),
})
