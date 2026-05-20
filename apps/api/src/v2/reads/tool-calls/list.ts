// Lane 6 — `POST /v2/reads/tool-calls/list` handler.
//
// Tenant-scoped, receipt-pinned page of tool calls plus a LATERAL
// join to the latest tool result per call. Filters mirror the lane
// doc: session, tool name, canonical tool type, errors-only, time
// bounds. Cursor is opaque base64url over `(timestamp_start,
// tool_call_id)` with descending time and id as the tiebreaker so
// the head of the list is page 1 regardless of insertion order.

import { z } from 'zod'
import type { RawExec } from '../../../db.js'
import { decodeCursor, encodeCursor } from '../shared/cursor.js'
import { verifiedProjectionWhere } from '../shared/verified-projection.js'

export const toolCallsListInput = z.object({
  sessionId: z.string().min(1).optional(),
  toolNames: z.array(z.string().min(1)).optional(),
  canonicalToolTypes: z.array(z.string().min(1)).optional(),
  errorsOnly: z.boolean().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  cursor: z.string().optional().nullable(),
  limit: z.number().int().min(1).max(500).default(50),
})

export type ToolCallsListInput = z.infer<typeof toolCallsListInput>

export type ToolCallHit = {
  toolCallId: string
  sessionId: string
  turnId: string | null
  toolName: string
  canonicalToolType: string | null
  status: string | null
  timestampStart: string | null
  storeId: string
  receiptId: string
  latestResult: {
    toolResultId: string
    status: string | null
    isError: boolean
    exitCode: number | null
    durationMs: number | null
  } | null
}

export type ToolCallsListResponse = {
  rows: ToolCallHit[]
  nextCursor: string | null
}

type DbRow = {
  tool_call_id: string
  session_id: string
  turn_id: string | null
  tool_name: string
  canonical_tool_type: string | null
  status: string | null
  timestamp_start: string | null
  store_id: string
  receipt_id: string
  latest_tool_result_id: string | null
  latest_status: string | null
  latest_is_error: boolean | null
  latest_exit_code: number | null
  latest_duration_ms: number | null
}

type Cursor = { ts: string | null; id: string }

export type ToolCallsDeps = {
  rawExec: RawExec
}

function appendParam(params: unknown[], value: unknown): string {
  params.push(value)
  return `$${params.length}`
}

export async function listToolCalls(
  deps: ToolCallsDeps,
  tenantId: string,
  input: ToolCallsListInput,
): Promise<ToolCallsListResponse> {
  const params: unknown[] = [tenantId]
  const clauses: string[] = [verifiedProjectionWhere('c', '$1')]

  if (input.sessionId) {
    clauses.push(`c.session_id = ${appendParam(params, input.sessionId)}`)
  }
  if (input.toolNames && input.toolNames.length > 0) {
    const placeholders = input.toolNames.map((t) => appendParam(params, t)).join(', ')
    clauses.push(`c.tool_name IN (${placeholders})`)
  }
  if (input.canonicalToolTypes && input.canonicalToolTypes.length > 0) {
    const placeholders = input.canonicalToolTypes.map((t) => appendParam(params, t)).join(', ')
    clauses.push(`c.canonical_tool_type IN (${placeholders})`)
  }
  if (input.since) {
    clauses.push(`c.timestamp_start >= ${appendParam(params, input.since)}::timestamptz`)
  }
  if (input.until) {
    clauses.push(`c.timestamp_start < ${appendParam(params, input.until)}::timestamptz`)
  }
  // `errorsOnly` checks the call's own status OR the latest result's
  // `is_error` flag; the LATERAL join below exposes both. Postgres
  // does not allow referencing the lateral alias from the WHERE
  // clause on the outer select, so we filter via a HAVING-style
  // outer wrapper.
  const errorsClause = input.errorsOnly
    ? `AND (
         lower(COALESCE(c.status, '')) IN ('error', 'failed', 'failure')
         OR (latest.is_error = TRUE)
       )`
    : ''

  const cursor = decodeCursor<Cursor>(input.cursor ?? undefined)
  let cursorClause = ''
  if (cursor) {
    const tsExpr = `COALESCE(to_char(c.timestamp_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')`
    const tsParam = appendParam(params, cursor.ts ?? '')
    const idParam = appendParam(params, cursor.id)
    // Descending order on timestamp + tool_call_id; "less than" is
    // the cursor advance comparator.
    cursorClause = ` AND (${tsExpr} < ${tsParam} OR (${tsExpr} = ${tsParam} AND c.tool_call_id < ${idParam}))`
  }

  const limitParam = appendParam(params, input.limit + 1)

  const sql = `
    SELECT c.tool_call_id, c.session_id, c.turn_id, c.tool_name, c.canonical_tool_type, c.status,
           to_char(c.timestamp_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp_start,
           c.store_id, c.receipt_id,
           latest.tool_result_id AS latest_tool_result_id,
           latest.status         AS latest_status,
           latest.is_error       AS latest_is_error,
           latest.exit_code      AS latest_exit_code,
           latest.duration_ms    AS latest_duration_ms
      FROM projection_tool_call c
      LEFT JOIN LATERAL (
        SELECT r.tool_result_id, r.status, r.is_error, r.exit_code, r.duration_ms
          FROM projection_tool_result r
         WHERE ${verifiedProjectionWhere('r', '$1')}
           AND r.tool_call_id = c.tool_call_id
         ORDER BY r.tool_result_id DESC
         LIMIT 1
      ) latest ON TRUE
     WHERE ${clauses.join(' AND ')}
       ${errorsClause}
       ${cursorClause}
     ORDER BY c.timestamp_start DESC NULLS LAST, c.tool_call_id DESC
     LIMIT ${limitParam}
  `

  const rows = await deps.rawExec<DbRow>(sql, params)
  const overflow = rows.length > input.limit
  const pageRows = overflow ? rows.slice(0, input.limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor = overflow && last ? encodeCursor({ ts: last.timestamp_start ?? '', id: last.tool_call_id }) : null

  return {
    rows: pageRows.map(mapRow),
    nextCursor,
  }
}

function mapRow(r: DbRow): ToolCallHit {
  return {
    toolCallId: r.tool_call_id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    toolName: r.tool_name,
    canonicalToolType: r.canonical_tool_type,
    status: r.status,
    timestampStart: r.timestamp_start,
    storeId: r.store_id,
    receiptId: r.receipt_id,
    latestResult: r.latest_tool_result_id
      ? {
          toolResultId: r.latest_tool_result_id,
          status: r.latest_status,
          isError: r.latest_is_error ?? false,
          exitCode: r.latest_exit_code,
          durationMs: r.latest_duration_ms,
        }
      : null,
  }
}
