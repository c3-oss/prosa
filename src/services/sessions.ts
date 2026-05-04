import type { Bundle } from '../core/bundle.js';
import type { Confidence, SourceTool } from '../core/domain/types.js';

export interface SessionListFilters {
  sourceTool?: SourceTool;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

export interface SessionRow {
  session_id: string;
  source_tool: SourceTool;
  source_session_id: string;
  parent_session_id: string | null;
  is_subagent: 0 | 1;
  title: string | null;
  start_ts: string | null;
  end_ts: string | null;
  cwd_initial: string | null;
  git_branch_initial: string | null;
  model_first: string | null;
  model_last: string | null;
  status: string | null;
  timeline_confidence: Confidence;
  message_count: number;
  tool_call_count: number;
}

export function listSessions(bundle: Bundle, filters: SessionListFilters = {}): SessionRow[] {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (filters.sourceTool) {
    conds.push('s.source_tool = ?');
    params.push(filters.sourceTool);
  }
  if (filters.sinceIso) {
    conds.push('(s.start_ts IS NULL OR s.start_ts >= ?)');
    params.push(filters.sinceIso);
  }
  if (filters.untilIso) {
    conds.push('(s.start_ts IS NULL OR s.start_ts < ?)');
    params.push(filters.untilIso);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(1000, filters.limit ?? 50));

  const sql = `
    SELECT s.session_id,
           s.source_tool,
           s.source_session_id,
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
  `;

  return bundle.db.prepare(sql).all(...params) as SessionRow[];
}

export interface SessionDetailEvent {
  ordinal: number;
  timestamp: string | null;
  event_type: string;
  source_type: string | null;
  subtype: string | null;
  actor: string | null;
  message_id: string | null;
  role: string | null;
  tool_name: string | null;
  is_error: 0 | 1 | null;
  preview: string | null;
}

export interface SessionDetail {
  session: SessionRow;
  events: SessionDetailEvent[];
}

export function getSession(bundle: Bundle, sessionId: string): SessionDetail | null {
  const rows = listSessions(bundle); // small query reused for shape
  const row = bundle.db
    .prepare<[string], SessionRow>(
      `SELECT s.session_id, s.source_tool, s.source_session_id, s.parent_session_id,
              s.is_subagent, s.title, s.start_ts, s.end_ts, s.cwd_initial,
              s.git_branch_initial, s.model_first, s.model_last, s.status,
              s.timeline_confidence,
              (SELECT count(*) FROM messages m WHERE m.session_id = s.session_id) AS message_count,
              (SELECT count(*) FROM tool_calls tc WHERE tc.session_id = s.session_id) AS tool_call_count
         FROM sessions s
        WHERE s.session_id = ?`,
    )
    .get(sessionId);
  void rows;
  if (!row) return null;

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
    .all(sessionId);

  return { session: row, events };
}
