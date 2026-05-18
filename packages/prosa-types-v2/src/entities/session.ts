import type { Confidence, SourceTool } from '../common.js'

export const SESSION_FIELDS = [
  'session_id',
  'source_tool',
  'source_session_id',
  'project_id',
  'parent_session_id',
  'parent_resolution',
  'is_subagent',
  'agent_role',
  'agent_nickname',
  'title',
  'summary',
  'start_ts',
  'end_ts',
  'cwd_initial',
  'git_branch_initial',
  'model_first',
  'model_last',
  'status',
  'timeline_confidence',
  'raw_record_id',
] as const

export type ParentResolution = 'inline' | 'edge_derived' | 'fixup_derived' | 'unresolved'

export type SessionV2 = {
  session_id: string
  source_tool: SourceTool
  source_session_id: string
  project_id: string | null
  parent_session_id: string | null
  parent_resolution: ParentResolution
  is_subagent: boolean
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

export const SESSION_PRIMARY_KEY: keyof SessionV2 = 'session_id'
