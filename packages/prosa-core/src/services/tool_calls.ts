import type { Bundle } from '../core/bundle.js'
import { clampLimit } from '../core/limits.js'

/** Entity kinds surfaced by tool-call history queries. */
export type ToolCallEntity = 'tool_call' | 'artifact'

/** Tool-call or artifact evidence row returned by file and command history queries. */
export interface ToolCallEvidence {
  /** Whether this row describes a tool call or a matching artifact. */
  entity_type: ToolCallEntity
  /** Session that owns the evidence. */
  session_id: string | null
  /** Tool call identifier when `entity_type` is `tool_call`. */
  tool_call_id: string | null
  /** Artifact identifier when `entity_type` is `artifact`. */
  artifact_id: string | null
  /** Native tool name. */
  tool_name: string | null
  /** Canonical tool category. */
  canonical_tool_type: string | null
  /** Command text, when the tool represents shell execution. */
  command: string | null
  /** File path associated with the tool call or artifact. */
  path: string | null
  /** Normalized tool call status. */
  status: string | null
  /** Tool call start timestamp or artifact creation timestamp. */
  timestamp_start: string | null
  /** SQLite boolean indicating an error result. */
  is_error: 0 | 1 | null
  /** Process exit code when available. */
  exit_code: number | null
  /** Human-sized result preview. */
  preview: string | null
}

/** Filters for tool-call history and file-history queries. */
export interface ToolCallFilters {
  /** Restrict evidence to one session. */
  sessionId?: string
  /** Restrict evidence to a native tool name. */
  toolName?: string
  /** Restrict evidence to a canonical tool category. */
  canonicalType?: string
  /** Match paths on tool calls and artifacts. */
  pathSubstring?: string
  /** Include only tool calls with error evidence. */
  errorsOnly?: boolean
  /** Inclusive lower bound for tool timestamps. */
  sinceIso?: string
  /** Exclusive upper bound for tool timestamps. */
  untilIso?: string
  /** Maximum rows to return, clamped by service limits. */
  limit?: number
}

/** Lists tool-call evidence, including artifacts when filtering by path substring. */
export function listToolCalls(bundle: Bundle, filters: ToolCallFilters = {}): ToolCallEvidence[] {
  const conds: string[] = []
  const params: unknown[] = []

  if (filters.toolName) {
    conds.push('tc.tool_name = ?')
    params.push(filters.toolName)
  }
  if (filters.canonicalType) {
    conds.push('tc.canonical_tool_type = ?')
    params.push(filters.canonicalType)
  }
  if (filters.sessionId) {
    conds.push('tc.session_id = ?')
    params.push(filters.sessionId)
  }
  if (filters.errorsOnly) {
    conds.push('(tr.is_error = 1 OR tc.status = ?)')
    params.push('error')
  }
  if (filters.pathSubstring) {
    conds.push('tc.path IS NOT NULL AND tc.path LIKE ?')
    params.push(`%${filters.pathSubstring}%`)
  }
  if (filters.sinceIso) {
    conds.push('(tc.timestamp_start IS NULL OR tc.timestamp_start >= ?)')
    params.push(filters.sinceIso)
  }
  if (filters.untilIso) {
    conds.push('(tc.timestamp_start IS NULL OR tc.timestamp_start < ?)')
    params.push(filters.untilIso)
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const limit = clampLimit(filters.limit, { max: 500, fallback: 100 })

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
  `

  if (!filters.pathSubstring) {
    const sql = `${toolCallSql} ORDER BY tc.timestamp_start DESC LIMIT ${limit}`
    return bundle.db.prepare(sql).all(...params) as ToolCallEvidence[]
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
  `
  const sql = `
    ${toolCallSql}
    UNION ALL
    ${artifactSql}
    ORDER BY timestamp_start DESC
    LIMIT ${limit}
  `
  return bundle.db.prepare(sql).all(...params, `%${filters.pathSubstring}%`) as ToolCallEvidence[]
}
