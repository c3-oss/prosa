import type { MessageRole, SearchFieldKind } from '../common.js'

export const SEARCH_DOC_FIELDS = [
  'doc_id',
  'entity_type',
  'entity_id',
  'session_id',
  'project_id',
  'timestamp',
  'role',
  'tool_name',
  'canonical_tool_type',
  'field_kind',
  'errors_only',
  'text',
] as const

export type SearchDocV2 = {
  doc_id: string
  entity_type: string
  entity_id: string
  session_id: string | null
  project_id: string | null
  timestamp: string | null
  role: MessageRole | null
  tool_name: string | null
  canonical_tool_type: string | null
  field_kind: SearchFieldKind
  errors_only: boolean
  text: string
}

export const SEARCH_DOC_PRIMARY_KEY: keyof SearchDocV2 = 'doc_id'
