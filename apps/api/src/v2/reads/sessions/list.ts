// Lane 6 — `POST /v2/reads/sessions/list` handler.
//
// Returns a cursor-paginated page of receipt-pinned sessions. The
// query layers three concerns on top of the verified-projection gate:
//
//   1. Cross-store conflict resolution. A logical session might be
//      promoted by more than one store; `DISTINCT ON (source_tool,
//      source_session_id)` collapses duplicates, picking the row
//      with the latest `end_ts` (ties broken by `receipt_id` desc).
//   2. Time-ordered paging. The outer query re-sorts the
//      conflict-resolved rows by `start_ts DESC, session_id DESC`
//      and applies the caller's cursor bound. The cursor encodes
//      `{ startedAt, id, snapshot }` so it stays stable across page
//      calls even when new rows arrive at the head.
//   3. CQ-142 — receipt-snapshot pinning. Page 1 resolves the
//      `(store_id, current_receipt_id)` set once and embeds it in
//      the cursor; subsequent pages use the same tuples instead of
//      re-resolving the live authority. A promotion between pages
//      does not skip / duplicate / mix receipts.

import { z } from 'zod'
import type { RawExec } from '../../../db.js'
import {
  type AuthoritySnapshot,
  InvalidCursorError,
  decodeRequiredCursor,
  encodeCursorSnapshot,
  parseCursorSnapshot,
  resolveAuthoritySnapshot,
} from '../shared/authority-snapshot.js'
import { encodeCursor } from '../shared/cursor.js'
import { type SessionListFilters, appendParam, buildSessionWhere, sessionListFilters } from './filters.js'

export const listSessionsInput = z
  .object({
    cursor: z.string().optional().nullable(),
    limit: z.number().int().min(1).max(500).default(50),
  })
  .merge(sessionListFilters)

export type ListSessionsInput = z.infer<typeof listSessionsInput>

export type SessionRow = {
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

export type ListSessionsResponse = {
  rows: SessionRow[]
  nextCursor: string | null
}

type DbRow = {
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

type StoredCursor = {
  startedAt: string | null
  id: string
  snapshot: Array<{ s: string; r: string }>
}

export type ListSessionsDeps = {
  rawExec: RawExec
}

export async function listSessions(
  deps: ListSessionsDeps,
  tenantId: string,
  input: ListSessionsInput,
): Promise<ListSessionsResponse> {
  const filters: SessionListFilters = {
    sourceTools: input.sourceTools,
    projectIds: input.projectIds,
    storeIds: input.storeIds,
    since: input.since,
    until: input.until,
    q: input.q,
  }

  // CQ-142: page 1 resolves the authority snapshot; subsequent
  // pages decode it from the cursor. Tampered / truncated cursors
  // surface as `InvalidCursorError` (HTTP 400 at the route layer).
  let snapshot: AuthoritySnapshot
  let cursorBound: { startedAt: string | null; id: string } | null = null
  const parsed = decodeRequiredCursor<StoredCursor>(input.cursor ?? undefined)
  if (parsed) {
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
      throw new InvalidCursorError('cursor.id missing')
    }
    if (parsed.startedAt != null && typeof parsed.startedAt !== 'string') {
      throw new InvalidCursorError('cursor.startedAt must be a string or null')
    }
    snapshot = parseCursorSnapshot(parsed.snapshot)
    cursorBound = { startedAt: parsed.startedAt, id: parsed.id }
  } else {
    snapshot = await resolveAuthoritySnapshot(deps.rawExec, tenantId)
  }

  const { whereSql, params } = buildSessionWhere(tenantId, filters, snapshot)
  const limit = input.limit
  const fetchLimit = limit + 1

  const innerSql = `
    SELECT DISTINCT ON (s.source_tool, s.source_session_id)
           s.session_id,
           s.source_tool,
           s.source_session_id,
           s.project_id,
           s.title,
           s.summary,
           s.start_ts,
           s.end_ts,
           s.status,
           s.store_id,
           s.receipt_id,
           s.is_subagent,
           s.parent_session_id,
           s.timeline_confidence
      FROM projection_session s
     WHERE ${whereSql}
     ORDER BY s.source_tool, s.source_session_id, s.end_ts DESC NULLS LAST, s.receipt_id DESC
  `

  let cursorClause = ''
  if (cursorBound) {
    const sortedExpr = `COALESCE(to_char(c.start_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')`
    const startedParam = appendParam(params, cursorBound.startedAt ?? '')
    const idParam = appendParam(params, cursorBound.id)
    cursorClause = ` WHERE (${sortedExpr} < ${startedParam} OR (${sortedExpr} = ${startedParam} AND c.session_id < ${idParam}))`
  }
  const limitParam = appendParam(params, fetchLimit)

  const sql = `
    WITH conflict_resolved AS (
      ${innerSql}
    )
    SELECT c.session_id,
           c.source_tool,
           c.source_session_id,
           c.project_id,
           c.title,
           c.summary,
           to_char(c.start_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_ts,
           to_char(c.end_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_ts,
           c.status,
           c.store_id,
           c.receipt_id,
           c.is_subagent,
           c.parent_session_id,
           c.timeline_confidence
      FROM conflict_resolved c
      ${cursorClause}
     ORDER BY COALESCE(c.start_ts, '1970-01-01') DESC, c.session_id DESC
     LIMIT ${limitParam}
  `

  const rows = await deps.rawExec<DbRow>(sql, params)
  const overflow = rows.length > limit
  const windowed = overflow ? rows.slice(0, limit) : rows
  const last = windowed[windowed.length - 1]
  const nextCursor =
    overflow && last
      ? encodeCursor({
          startedAt: last.start_ts ?? '',
          id: last.session_id,
          snapshot: encodeCursorSnapshot(snapshot),
        })
      : null

  return {
    rows: windowed.map(mapRow),
    nextCursor,
  }
}

function mapRow(r: DbRow): SessionRow {
  return {
    id: r.session_id,
    sourceTool: r.source_tool,
    sourceSessionId: r.source_session_id,
    projectId: r.project_id,
    title: r.title,
    summary: r.summary,
    startedAt: r.start_ts,
    endedAt: r.end_ts,
    status: r.status,
    storeId: r.store_id,
    receiptId: r.receipt_id,
    isSubagent: r.is_subagent,
    parentSessionId: r.parent_session_id,
    timelineConfidence: r.timeline_confidence,
  }
}
