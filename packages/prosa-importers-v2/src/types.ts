// Lane 2 — importer contract.
//
// The product surface is small: every importer plugs into this interface,
// and the orchestrator drives the Reserve → parse → register → seal flow.
// All canonical-projection types are re-exported from `prosa-types-v2` so
// importers never invent their own row shapes.

import type {
  ArtifactV2,
  CanonicalEntityType,
  ContentBlockV2,
  EdgeV2,
  EventV2,
  MessageV2,
  ProjectV2,
  RawRecordV2,
  RawSourceLeafInput,
  SearchDocV2,
  SessionV2,
  SourceFileV2,
  SourceTool,
  ToolCallV2,
  ToolResultV2,
  TurnV2,
} from '@c3-oss/prosa-types-v2'

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

// `CanonicalProjectionDraft` mirrors the projection grain by entity type.
// Importers populate it; the orchestrator forwards it into the
// EpochHandle.
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
  raw_records: RawRecordV2[]
  source_files: SourceFileV2[]
}

export function emptyDraft(): CanonicalProjectionDraft {
  return {
    projects: [],
    sessions: [],
    turns: [],
    events: [],
    messages: [],
    content_blocks: [],
    tool_calls: [],
    tool_results: [],
    artifacts: [],
    edges: [],
    search_docs: [],
    raw_records: [],
    source_files: [],
  }
}

/**
 * One CAS-bound payload an importer has already referenced via
 * `*_object_id` in a projection row. The importer computes the
 * canonical `object_id` with `computeObjectId(bytes)` and stores it on
 * the staged row; the orchestrator hands the bytes to
 * `CasPackWriterPool.appendObject`, which derives the same object_id
 * and packs the bytes. The pool dedupes on object_id, so duplicate
 * candidates across importers (and within a single importer) are
 * cheap.
 */
export type CasObjectCandidate = {
  /** Canonical CAS identity (`blake3:<hex>`) the importer already wrote into the row. */
  object_id: string
  /** Bytes the pool admits; pool re-derives object_id from `blake3(bytes)` and rejects any mismatch. */
  bytes: Uint8Array
  /** Optional MIME hint persisted alongside the pack entry. */
  mime_type?: string
}

export type LogicalImportUnit = {
  unit_id: string
  source_tool: SourceTool
  logical_kind: LogicalKind
  /** 1+ source files contributing to this unit. */
  source_file_ids: string[]
  raw_record_ids: string[]
  /** Raw bytes for each source file in `source_file_ids`, indexed by id. */
  raw_source_payloads: Map<string, Uint8Array>
  projection: CanonicalProjectionDraft
  /** Each source file's raw-source leaf input. */
  raw_source_leaves: RawSourceLeafInput[]
  /**
   * Every `*_object_id` reference the importer wrote into a projection
   * row. The orchestrator drives `CasPackWriterPool.appendObject` for
   * each entry so the bytes land in a registered `cas_object_pack`
   * segment before `sealEpoch` validates FK closure on
   * `OBJECT_ID_FIELDS`. Empty when the importer references no CAS
   * objects in this unit.
   */
  cas_object_candidates: CasObjectCandidate[]
  merge: {
    merge_strategy: MergeStrategy
    selected_source_file_id?: string
    candidates?: MergeCandidate[]
  }
}

// Discovery + identification + full parse. Providers implement the
// interface; the orchestrator drives them.
export type DiscoveredSourceFile = {
  source_file_id: string
  path: string
  source_tool: SourceTool
  /** Provider-defined "file kind" (e.g. `session_jsonl`, `session_sqlite`). */
  file_kind: string
  /** Bytes already preloaded for small fixtures, OR null to lazy-read. */
  bytes?: Uint8Array
}

export type CheapIdentification = {
  /**
   * Canonical key used to Reserve the logical session. Multiple source
   * files that resolve to the same logical session must produce the
   * same `logicalKey`.
   */
  logicalKey: Uint8Array
  /** The unit id this file will land in (deterministic). */
  unit_id: string
  /** The logical kind being identified. */
  logical_kind: LogicalKind
}

export type ProviderProjectInput = {
  /** Files this unit owns; identified earlier as the reservation winner. */
  files: DiscoveredSourceFile[]
  /** The cheap identification result. */
  identification: CheapIdentification
  /** Canonical UTC ms-precision timestamp for this epoch. */
  createdAt: string
}

export type ProviderProjectResult = {
  unit: LogicalImportUnit
  /** Pretty-printer-friendly summary (used by tests / CLI). */
  summary: {
    files: number
    sessions: number
    rawRecords: number
  }
}

export interface Provider {
  /** Constant identifying the provider in canonical projection rows. */
  readonly source_tool: SourceTool
  /** Walk the provider's discovery root and emit every source file it owns. */
  discover(root: string): Promise<DiscoveredSourceFile[]>
  /**
   * Cheap-identify a discovered file to derive the canonical logical
   * key used by the Reserve flow. MUST be deterministic and cheap (no
   * full parse).
   */
  cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification>
  /** Full parse + canonical projection assembly. */
  parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult>
}

// Helper: produce the per-entity tuple that the orchestrator uses to
// register projection segments.
export const PROJECTION_ENTITY_ORDER: readonly CanonicalEntityType[] = [
  'project',
  'source_file',
  'raw_record',
  'session',
  'turn',
  'event',
  'message',
  'content_block',
  'tool_call',
  'tool_result',
  'artifact',
  'edge',
  'search_doc',
]
