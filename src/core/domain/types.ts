// Row-shaped TypeScript types matching the SQLite schema. These are the
// boundary contract between importers and the catalog. Optional fields use
// `null` (not `undefined`) to mirror SQLite NULL semantics directly.

export const SOURCE_TOOLS = ['cursor', 'codex', 'claude', 'gemini'] as const
export type SourceTool = (typeof SOURCE_TOOLS)[number]

export type Confidence = 'high' | 'medium' | 'low'

export type MessageRole = 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'

export type CanonicalToolType =
  | 'shell'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search_file'
  | 'web_search'
  | 'mcp'
  | 'subagent'
  | 'patch'
  | 'other'

export type EdgeType =
  | 'parent_of'
  | 'calls'
  | 'returns'
  | 'spawned'
  | 'contains'
  | 'produced'
  | 'consumed'
  | 'derived_from'
  | 'summarizes'
  | 'compacts'
  | 'same_as'
  | 'refers_to'

export type ToolCallStatus = 'started' | 'success' | 'error' | 'cancelled' | 'unknown'

export interface SessionRowFull {
  session_id: string
  source_tool: SourceTool
  source_session_id: string
  project_id: string | null
  parent_session_id: string | null
  is_subagent: 0 | 1
  agent_role: string | null
  agent_nickname: string | null
  title: string | null
  summary: string | null
  start_ts: string | null
  end_ts: string | null
  cwd_initial: string | null
  git_branch_initial: string | null
  model_first: string | null
  model_last: string | null
  status: string | null
  timeline_confidence: Confidence
  raw_record_id: string | null
}
