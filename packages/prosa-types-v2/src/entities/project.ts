import type { SourceTool } from '../common.js'

// Field order is the canonical schema order. See CANONICAL.md rule 1.
export const PROJECT_FIELDS = [
  'project_id',
  'canonical_path',
  'path_hash',
  'source_tool',
  'source_project_id',
  'display_name',
  'created_at',
] as const

export type ProjectV2 = {
  project_id: string
  canonical_path: string | null
  path_hash: string | null
  source_tool: SourceTool | null
  source_project_id: string | null
  display_name: string | null
  created_at: string
}

export const PROJECT_PRIMARY_KEY: keyof ProjectV2 = 'project_id'
