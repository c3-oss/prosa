import type { SourceTool } from './common.js'
import type {
  ArtifactV2,
  ContentBlockV2,
  EdgeV2,
  EventV2,
  MessageV2,
  ProjectV2,
  SearchDocV2,
  SessionV2,
  ToolCallV2,
  ToolResultV2,
  TurnV2,
} from './entities/index.js'

export type LogicalKind = 'session' | 'artifact' | 'project' | 'source_only'

export type MergeStrategy =
  | 'single_source'
  | 'hermes_sqlite_plus_jsonl'
  | 'gemini_session_versions'
  | 'provider_specific'

export type MergeCandidate = {
  source_file_id: string
  source_kind: string
  message_count?: number
  confidence: 'high' | 'medium' | 'low'
}

// CanonicalProjectionDraft is the projection payload assembled by an importer
// for a single LogicalImportUnit, before idempotent merge with shard state.
export type CanonicalProjectionDraft = {
  projects: ProjectV2[]
  sessions: SessionV2[]
  turns: TurnV2[]
  events: EventV2[]
  messages: MessageV2[]
  content_blocks: ContentBlockV2[]
  tool_calls: ToolCallV2[]
  tool_results: ToolResultV2[]
  artifacts: ArtifactV2[]
  edges: EdgeV2[]
  search_docs: SearchDocV2[]
}

export type LogicalImportUnit = {
  unit_id: string
  source_tool: SourceTool
  logical_kind: LogicalKind
  source_file_ids: string[]
  raw_record_ids: string[]
  projection: CanonicalProjectionDraft
  merge: {
    merge_strategy: MergeStrategy
    selected_source_file_id?: string
    candidates?: MergeCandidate[]
  }
}
