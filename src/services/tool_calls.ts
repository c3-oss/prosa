import type { Bundle } from '../core/bundle.js';
import { clampLimit } from '../core/limits.js';

export type ToolCallEntity = 'tool_call' | 'artifact';

export interface ToolCallEvidence {
  entity_type: ToolCallEntity;
  session_id: string | null;
  tool_call_id: string | null;
  artifact_id: string | null;
  tool_name: string | null;
  canonical_tool_type: string | null;
  command: string | null;
  path: string | null;
  status: string | null;
  timestamp_start: string | null;
  is_error: 0 | 1 | null;
  exit_code: number | null;
  preview: string | null;
}

export interface ToolCallFilters {
  sessionId?: string;
  toolName?: string;
  canonicalType?: string;
  pathSubstring?: string;
  errorsOnly?: boolean;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

export function listToolCalls(bundle: Bundle, filters: ToolCallFilters = {}): ToolCallEvidence[] {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (filters.toolName) {
    conds.push('tc.tool_name = ?');
    params.push(filters.toolName);
  }
  if (filters.canonicalType) {
    conds.push('tc.canonical_tool_type = ?');
    params.push(filters.canonicalType);
  }
  if (filters.sessionId) {
    conds.push('tc.session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.errorsOnly) {
    conds.push('(tr.is_error = 1 OR tc.status = ?)');
    params.push('error');
  }
  if (filters.pathSubstring) {
    conds.push('tc.path IS NOT NULL AND tc.path LIKE ?');
    params.push(`%${filters.pathSubstring}%`);
  }
  if (filters.sinceIso) {
    conds.push('(tc.timestamp_start IS NULL OR tc.timestamp_start >= ?)');
    params.push(filters.sinceIso);
  }
  if (filters.untilIso) {
    conds.push('(tc.timestamp_start IS NULL OR tc.timestamp_start < ?)');
    params.push(filters.untilIso);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = clampLimit(filters.limit, { max: 500, fallback: 100 });

  const toolCallSql = `
    SELECT 'tool_call' AS entity_type,
           tc.session_id,
           tc.tool_call_id,
           NULL AS artifact_id,
           tc.tool_name,
           tc.canonical_tool_type,
           tc.command,
           tc.path,
           tc.status,
           tc.timestamp_start,
           tr.is_error,
           tr.exit_code,
           tr.preview
      FROM tool_calls tc
      LEFT JOIN tool_results tr ON tr.tool_call_id = tc.tool_call_id
      ${where}
  `;

  if (!filters.pathSubstring) {
    const sql = `${toolCallSql} ORDER BY tc.timestamp_start DESC LIMIT ${limit}`;
    return bundle.db.prepare(sql).all(...params) as ToolCallEvidence[];
  }

  // path_substring is set: also surface artifacts with matching paths so
  // file-history queries return both tool_calls that touched a path and
  // artifacts produced for that path.
  const artifactSql = `
    SELECT 'artifact' AS entity_type,
           a.session_id,
           NULL AS tool_call_id,
           a.artifact_id,
           NULL AS tool_name,
           NULL AS canonical_tool_type,
           NULL AS command,
           a.path,
           NULL AS status,
           a.created_ts AS timestamp_start,
           NULL AS is_error,
           NULL AS exit_code,
           NULL AS preview
      FROM artifacts a
     WHERE a.path IS NOT NULL AND a.path LIKE ?
  `;
  const sql = `
    ${toolCallSql}
    UNION ALL
    ${artifactSql}
    ORDER BY timestamp_start DESC
    LIMIT ${limit}
  `;
  return bundle.db.prepare(sql).all(...params, `%${filters.pathSubstring}%`) as ToolCallEvidence[];
}
