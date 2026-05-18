// Shared enumerations and string-literal unions used across the canonical
// projection types. These are stable wire/schema concepts; renaming any value
// requires a CANONICAL.md ADR.

export type SourceTool = 'codex' | 'claude' | 'cursor' | 'gemini' | 'hermes'

export type Confidence = 'high' | 'medium' | 'low'

export type Visibility = 'default' | 'hidden_by_default' | 'audit_only'

export type Actor = 'user' | 'assistant' | 'tool' | 'system' | 'cli'

export type MessageRole = 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'

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

export type EdgeSource = 'explicit' | 'path_inferred' | 'timestamp_inferred' | 'content_inferred'

export type SearchFieldKind =
  | 'message_text'
  | 'user_prompt'
  | 'assistant_text'
  | 'system_prompt'
  | 'command'
  | 'command_output_preview'
  | 'error'
  | 'file_path'
  | 'diff'
  | 'summary'
  | 'artifact_text'
  | 'tool_args'
  | 'tool_result'

// CanonicalEntityType is declared in alphabetical order. This order is
// load-bearing: it determines the across-entity-type sub-root ordering used
// by `merkleRoot`. See CANONICAL.md rule 7.
export const CANONICAL_ENTITY_TYPES = [
  'artifact',
  'content_block',
  'edge',
  'event',
  'message',
  'project',
  'raw_record',
  'search_doc',
  'session',
  'source_file',
  'tool_call',
  'tool_result',
  'turn',
] as const

export type CanonicalEntityType = (typeof CANONICAL_ENTITY_TYPES)[number]

export type SegmentKind =
  | 'raw_source_pack'
  | 'cas_object_pack'
  | 'projection_arrow'
  | 'projection_parquet'
  | 'search_docs_arrow'
  | 'session_blob_pack'
  | 'manifest'
  | 'inventory_object'
  | 'inventory_projection'
