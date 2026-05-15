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

type ToolCallRow = {
  id: string
  session_id: string
  session_title: string | null
  source_kind: string
  name: string
  status: string | null
  created_at: string | null
  finished_at: string | null
  result_status: string | null
  input_object_id: string | null
  output_object_id: string | null
}

export const toolCallsRouter = router({
  list: tenantProcedure.input(toolCallsListInput.default({})).query(async ({ ctx, input }) => {
    const params: unknown[] = [ctx.tenantId]
    const clauses = [tenantVerifiedProjectionSql('s', 'session'), 't.tenant_id = $1']
    if (input.sessionId) {
      const param = appendParam(params, input.sessionId)
      clauses.push(`t.session_id = ${param}`)
    }
    if (input.toolNames && input.toolNames.length > 0) {
      const placeholders = input.toolNames.map((n) => appendParam(params, n)).join(', ')
      clauses.push(`t.name IN (${placeholders})`)
    }
    if (input.statuses && input.statuses.length > 0) {
      const placeholders = input.statuses.map((status) => appendParam(params, status)).join(', ')
      clauses.push(`t.status IN (${placeholders})`)
    }
    if (input.errorsOnly) {
      clauses.push(`(t.status NOT IN ('ok','success','completed') OR r.status NOT IN ('ok','success','completed'))`)
    }
    if (input.sourceKinds && input.sourceKinds.length > 0) {
      const placeholders = input.sourceKinds.map((k) => appendParam(params, k)).join(', ')
      clauses.push(`s.source_kind IN (${placeholders})`)
    }
    if (input.since) {
      const param = appendParam(params, input.since)
      clauses.push(`t.created_at >= ${param}`)
    }
    if (input.until) {
      const param = appendParam(params, input.until)
      clauses.push(`t.created_at < ${param}`)
    }

    const cursor = decodeCursor<{ at: string | null; id: string }>(input.cursor)
    if (cursor) {
      const atParam = appendParam(params, cursor.at)
      const idParam = appendParam(params, cursor.id)
      clauses.push(
        `(COALESCE(t.created_at::text, '') < ${atParam} OR (COALESCE(t.created_at::text, '') = ${atParam} AND t.id < ${idParam}))`,
      )
    }
    const limit = input.limit + 1
    const limitParam = appendParam(params, limit)
    const rows = await ctx.rawExec<ToolCallRow>(
      `SELECT t.id, t.session_id, t.name, t.status, t.created_at, t.input_object_id,
              s.source_kind, s.title AS session_title,
              r.status AS result_status, r.finished_at, r.output_object_id
         FROM "projection_tool_call" t
         JOIN "projection_session" s
           ON s.tenant_id = t.tenant_id AND s.id = t.session_id
    LEFT JOIN "projection_tool_result" r
           ON r.tenant_id = t.tenant_id AND r.tool_call_id = t.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(t.created_at, '1970-01-01') DESC, t.id DESC
        LIMIT ${limitParam}`,
      params,
    )
    const overflow = rows.length > input.limit
    const window = overflow ? rows.slice(0, input.limit) : rows
    const last = window[window.length - 1]
    const nextCursor =
      overflow && last
        ? encodeCursor({
            at: last.created_at ? new Date(last.created_at).toISOString() : '',
            id: last.id,
          })
        : null
    const page: CursorPage<{
      id: string
      sessionId: string
      sessionTitle: string | null
      sourceKind: string
      name: string
      canonicalType: string | null
      status: string | null
      startedAt: string | null
      finishedAt: string | null
      durationMs: number | null
      inputObjectId: string | null
      outputObjectId: string | null
      resultStatus: string | null
    }> = {
      rows: window.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        sourceKind: row.source_kind,
        name: row.name,
        canonicalType: null,
        status: row.status,
        startedAt: row.created_at,
        finishedAt: row.finished_at,
        durationMs:
          row.created_at && row.finished_at
            ? Math.max(0, Date.parse(row.finished_at) - Date.parse(row.created_at))
            : null,
        inputObjectId: row.input_object_id,
        outputObjectId: row.output_object_id,
        resultStatus: row.result_status,
      })),
      nextCursor,
    }
    return page
  }),
})
