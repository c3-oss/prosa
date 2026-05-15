import type { Bundle } from '../core/bundle.js'
import type { Confidence, SourceTool } from '../core/domain/types.js'
import { clampLimit } from '../core/limits.js'

/** Filters applied consistently to session list and count queries. */
export interface SessionListFilters {
  /** Restrict results to one source tool. */
  sourceTool?: SourceTool
  /** Inclusive lower bound for `start_ts`; unknown timestamps are retained. */
  sinceIso?: string
  /** Exclusive upper bound for `start_ts`; unknown timestamps are retained. */
  untilIso?: string
  /** Maximum rows to return, clamped by service limits. */
  limit?: number
}

/** Summary row returned by session listing surfaces. */
export interface SessionRow {
  /** Canonical prosa session identifier. */
  session_id: string
  /** Source tool that produced the session. */
  source_tool: SourceTool
  /** Native source session identifier. */
  source_session_id: string
  /** Canonical project identifier this session belongs to, when one was recovered. */
  project_id: string | null
  /** Parent session for subagent sessions. */
  parent_session_id: string | null
  /** SQLite boolean indicating whether this is a subagent session. */
  is_subagent: 0 | 1
  /** Best recovered title. */
  title: string | null
  /** Earliest recovered timestamp. */
  start_ts: string | null
  /** Latest recovered timestamp. */
  end_ts: string | null
  /** Initial working directory. */
  cwd_initial: string | null
  /** Initial git branch. */
  git_branch_initial: string | null
  /** First observed model. */
  model_first: string | null
  /** Last observed model. */
  model_last: string | null
  /** Source or importer status. */
  status: string | null
  /** Confidence in recovered timeline ordering. */
  timeline_confidence: Confidence
  /** Number of messages attached to the session. */
  message_count: number
  /** Number of tool calls attached to the session. */
  tool_call_count: number
}

/** Builds the shared WHERE clause so list and count stay filter-equivalent. */
function sessionFilterWhere(filters: SessionListFilters): { where: string; params: unknown[] } {
  const conds: string[] = []
  const params: unknown[] = []

  if (filters.sourceTool) {
    conds.push('s.source_tool = ?')
    params.push(filters.sourceTool)
  }
  if (filters.sinceIso) {
    conds.push('(s.start_ts IS NULL OR s.start_ts >= ?)')
    params.push(filters.sinceIso)
  }
  if (filters.untilIso) {
    conds.push('(s.start_ts IS NULL OR s.start_ts < ?)')
    params.push(filters.untilIso)
  }

  return {
    where: conds.length ? `WHERE ${conds.join(' AND ')}` : '',
    params,
  }
}

/** Lists sessions newest-first, preserving rows with unknown timestamps at the end. */
export function listSessions(bundle: Bundle, filters: SessionListFilters = {}): SessionRow[] {
  const { where, params } = sessionFilterWhere(filters)
  const limit = clampLimit(filters.limit, { max: 1000, fallback: 50 })

  const sql = `
    SELECT s.session_id,
           s.source_tool,
           s.source_session_id,
           s.project_id,
           s.parent_session_id,
           s.is_subagent,
           s.title,
           s.start_ts,
           s.end_ts,
           s.cwd_initial,
           s.git_branch_initial,
           s.model_first,
           s.model_last,
           s.status,
           s.timeline_confidence,
           (SELECT count(*) FROM messages m WHERE m.session_id = s.session_id) AS message_count,
           (SELECT count(*) FROM tool_calls tc WHERE tc.session_id = s.session_id) AS tool_call_count
      FROM sessions s
      ${where}
     ORDER BY s.start_ts DESC NULLS LAST
     LIMIT ${limit}
  `

  return bundle.db.prepare(sql).all(...params) as SessionRow[]
}

/** Counts sessions using the same filter policy as {@link listSessions}. */
export function countSessions(bundle: Bundle, filters: SessionListFilters = {}): number {
  const { where, params } = sessionFilterWhere(filters)
  const row = bundle.db
    .prepare(
      `
        SELECT count(*) AS count
          FROM sessions s
          ${where}
      `,
    )
    .get(...params) as { count: number } | undefined

  return row?.count ?? 0
}

/** Timeline event row used by session detail views. */
export interface SessionDetailEvent {
  /** Timeline ordinal within the session. */
  ordinal: number
  /** Event timestamp when known. */
  timestamp: string | null
  /** Canonical event type. */
  event_type: string
  /** Native source event type, when retained. */
  source_type: string | null
  /** Source-specific event subtype. */
  subtype: string | null
  /** Actor associated with the event. */
  actor: string | null
  /** Message row attached to the event. */
  message_id: string | null
  /** Message role attached to the event. */
  role: string | null
  /** Tool name attached to the event. */
  tool_name: string | null
  /** SQLite boolean indicating a failed tool result. */
  is_error: 0 | 1 | null
  /** Human-sized preview for detail rendering. */
  preview: string | null
}

/** Full session detail with summary metadata and ordered timeline events. */
export interface SessionDetail {
  /** Session summary row. */
  session: SessionRow
  /** Ordered timeline events. */
  events: SessionDetailEvent[]
}

/** Returns a single session with its event timeline, or null when absent. */
export function getSession(bundle: Bundle, sessionId: string): SessionDetail | null {
  const rows = listSessions(bundle) // small query reused for shape
  const row = bundle.db
    .prepare<[string], SessionRow>(
      `SELECT s.session_id, s.source_tool, s.source_session_id, s.project_id,
              s.parent_session_id, s.is_subagent, s.title, s.start_ts, s.end_ts,
              s.cwd_initial, s.git_branch_initial, s.model_first, s.model_last,
              s.status, s.timeline_confidence,
              (SELECT count(*) FROM messages m WHERE m.session_id = s.session_id) AS message_count,
              (SELECT count(*) FROM tool_calls tc WHERE tc.session_id = s.session_id) AS tool_call_count
         FROM sessions s
        WHERE s.session_id = ?`,
    )
    .get(sessionId)
  void rows
  if (!row) return null

  const events = bundle.db
    .prepare<[string], SessionDetailEvent>(
      `SELECT e.ordinal,
              e.timestamp,
              e.event_type,
              e.source_type,
              e.subtype,
              e.actor,
              m.message_id,
              m.role,
              tc.tool_name,
              tr.is_error,
              tr.preview
         FROM events e
         LEFT JOIN messages m   ON m.event_id = e.event_id
         LEFT JOIN tool_calls tc ON tc.event_id = e.event_id
         LEFT JOIN tool_results tr ON tr.event_id = e.event_id
        WHERE e.session_id = ?
        ORDER BY e.ordinal`,
    )
    .all(sessionId)

  return { session: row, events }
}
