// Lane 6 — `POST /v2/reads/sessions/detail` handler.
//
// Returns the session header for a single id plus *verified* counts
// of related projections (messages, tool calls, errors, content
// blocks, artifacts). Each count subquery composes the
// verified-projection gate so a count is bounded to receipt-pinned
// rows — counting a logical session's superseded events would
// surface invisible data, which the lane invariants forbid.
//
// `auxiliaryRowsAvailable` is `true` once the projection
// materialization path (Lane 10 scope) populates the projection
// tables. The detail handler does not gate it on that path; the
// reads always work, they just count zero when the projection
// tables are empty.

import { z } from 'zod'
import type { RawExec } from '../../../db.js'
import { verifiedProjectionWhere } from '../shared/verified-projection.js'

export const sessionDetailInput = z.object({
  sessionId: z.string().min(1),
})

export type SessionDetailInput = z.infer<typeof sessionDetailInput>

export type SessionDetailRow = {
  id: string
  sourceTool: string
  sourceSessionId: string
  projectId: string | null
  title: string | null
  summary: string | null
  startedAt: string | null
  endedAt: string | null
  status: string | null
  storeId: string
  receiptId: string
  isSubagent: boolean
  parentSessionId: string | null
  timelineConfidence: string
}

export type SessionDetailResponse =
  | {
      found: true
      session: SessionDetailRow
      counts: {
        messages: number
        toolCalls: number
        toolResultErrors: number
        contentBlocks: number
        events: number
        artifacts: number
      }
      auxiliaryRowsAvailable: true
    }
  | { found: false }

export type GetSessionDetailDeps = {
  rawExec: RawExec
}

type HeaderRow = {
  session_id: string
  source_tool: string
  source_session_id: string
  project_id: string | null
  title: string | null
  summary: string | null
  start_ts: string | null
  end_ts: string | null
  status: string | null
  store_id: string
  receipt_id: string
  is_subagent: boolean
  parent_session_id: string | null
  timeline_confidence: string
}

export async function getSessionDetail(
  deps: GetSessionDetailDeps,
  tenantId: string,
  input: SessionDetailInput,
): Promise<SessionDetailResponse> {
  const header = await deps.rawExec<HeaderRow>(
    `SELECT s.session_id, s.source_tool, s.source_session_id, s.project_id, s.title, s.summary,
            to_char(s.start_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_ts,
            to_char(s.end_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_ts,
            s.status, s.store_id, s.receipt_id, s.is_subagent, s.parent_session_id, s.timeline_confidence
       FROM projection_session s
      WHERE ${verifiedProjectionWhere('s')}
        AND s.session_id = $2
      LIMIT 1`,
    [tenantId, input.sessionId],
  )
  const row = header[0]
  if (!row) return { found: false }

  const [msgs, calls, errs, blocks, events, artifacts] = await Promise.all([
    countVerified(deps.rawExec, tenantId, 'projection_message', input.sessionId, 'm', { keyCol: 'message_id' }),
    countVerified(deps.rawExec, tenantId, 'projection_tool_call', input.sessionId, 't', { keyCol: 'tool_call_id' }),
    countVerified(deps.rawExec, tenantId, 'projection_tool_result', input.sessionId, 'r', {
      keyCol: 'tool_result_id',
      extra: 'AND r.is_error = TRUE',
    }),
    countVerified(deps.rawExec, tenantId, 'projection_content_block', input.sessionId, 'b', { keyCol: 'block_id' }),
    countVerified(deps.rawExec, tenantId, 'projection_event', input.sessionId, 'e', { keyCol: 'event_id' }),
    countVerified(deps.rawExec, tenantId, 'projection_artifact', input.sessionId, 'a', {
      keyCol: 'artifact_id',
      // `projection_artifact.session_id` is nullable for orphan
      // attachments; the detail count excludes those by matching
      // exactly on the requested session id.
    }),
  ])

  return {
    found: true,
    session: {
      id: row.session_id,
      sourceTool: row.source_tool,
      sourceSessionId: row.source_session_id,
      projectId: row.project_id,
      title: row.title,
      summary: row.summary,
      startedAt: row.start_ts,
      endedAt: row.end_ts,
      status: row.status,
      storeId: row.store_id,
      receiptId: row.receipt_id,
      isSubagent: row.is_subagent,
      parentSessionId: row.parent_session_id,
      timelineConfidence: row.timeline_confidence,
    },
    counts: {
      messages: msgs,
      toolCalls: calls,
      toolResultErrors: errs,
      contentBlocks: blocks,
      events,
      artifacts,
    },
    auxiliaryRowsAvailable: true,
  }
}

async function countVerified(
  rawExec: RawExec,
  tenantId: string,
  table: string,
  sessionId: string,
  alias: string,
  opts: { keyCol: string; extra?: string },
): Promise<number> {
  // `keyCol` is referenced only to keep the alias used in the gate
  // active for the planner; the count does not depend on the row id.
  void opts.keyCol
  const sql = `
    SELECT COUNT(*)::int AS count FROM "${table}" ${alias}
     WHERE ${verifiedProjectionWhere(alias)}
       AND ${alias}.session_id = $2
       ${opts.extra ?? ''}
  `
  const rows = await rawExec<{ count: number }>(sql, [tenantId, sessionId])
  return rows[0]?.count ?? 0
}
