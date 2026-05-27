import type { SourceTool } from '../common.js'

export const ARTIFACT_FIELDS = [
  'artifact_id',
  'session_id',
  'project_id',
  'source_tool',
  'kind',
  'path',
  'logical_path',
  'object_id',
  'text_object_id',
  'mime_type',
  'size_bytes',
  'created_ts',
  'raw_record_id',
] as const

export type ArtifactV2 = {
  artifact_id: string
  session_id: string | null
  project_id: string | null
  source_tool: SourceTool
  kind: string
  path: string | null
  logical_path: string | null
  object_id: string | null
  text_object_id: string | null
  mime_type: string | null
  size_bytes: number
  created_ts: string | null
  raw_record_id: string
}

export const ARTIFACT_PRIMARY_KEY: keyof ArtifactV2 = 'artifact_id'
