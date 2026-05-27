import type { CanonicalEntityType } from '../common.js'

import { ARTIFACT_FIELDS, ARTIFACT_PRIMARY_KEY } from './artifact.js'
import { CONTENT_BLOCK_FIELDS, CONTENT_BLOCK_PRIMARY_KEY } from './content-block.js'
import { EDGE_FIELDS, EDGE_PRIMARY_KEY } from './edge.js'
import { EVENT_FIELDS, EVENT_PRIMARY_KEY } from './event.js'
import { MESSAGE_FIELDS, MESSAGE_PRIMARY_KEY } from './message.js'
import { PROJECT_FIELDS, PROJECT_PRIMARY_KEY } from './project.js'
import { RAW_RECORD_FIELDS, RAW_RECORD_PRIMARY_KEY } from './raw-record.js'
import { SEARCH_DOC_FIELDS, SEARCH_DOC_PRIMARY_KEY } from './search-doc.js'
import { SESSION_FIELDS, SESSION_PRIMARY_KEY } from './session.js'
import { SOURCE_FILE_FIELDS, SOURCE_FILE_PRIMARY_KEY } from './source-file.js'
import { TOOL_CALL_FIELDS, TOOL_CALL_PRIMARY_KEY } from './tool-call.js'
import { TOOL_RESULT_FIELDS, TOOL_RESULT_PRIMARY_KEY } from './tool-result.js'
import { TURN_FIELDS, TURN_PRIMARY_KEY } from './turn.js'

export * from './artifact.js'
export * from './content-block.js'
export * from './edge.js'
export * from './event.js'
export * from './message.js'
export * from './project.js'
export * from './raw-record.js'
export * from './search-doc.js'
export * from './session.js'
export * from './source-file.js'
export * from './tool-call.js'
export * from './tool-result.js'
export * from './turn.js'

// Schema-order map keyed by CanonicalEntityType. Field order here is the
// canonical encoding order from rule 1 of CANONICAL.md. Any reordering is a
// breaking change to every Merkle leaf in the system and requires an ADR.
export const ENTITY_SCHEMA_ORDER = {
  artifact: ARTIFACT_FIELDS,
  content_block: CONTENT_BLOCK_FIELDS,
  edge: EDGE_FIELDS,
  event: EVENT_FIELDS,
  message: MESSAGE_FIELDS,
  project: PROJECT_FIELDS,
  raw_record: RAW_RECORD_FIELDS,
  search_doc: SEARCH_DOC_FIELDS,
  session: SESSION_FIELDS,
  source_file: SOURCE_FILE_FIELDS,
  tool_call: TOOL_CALL_FIELDS,
  tool_result: TOOL_RESULT_FIELDS,
  turn: TURN_FIELDS,
} as const satisfies Record<CanonicalEntityType, readonly string[]>

export const ENTITY_PRIMARY_KEY = {
  artifact: ARTIFACT_PRIMARY_KEY,
  content_block: CONTENT_BLOCK_PRIMARY_KEY,
  edge: EDGE_PRIMARY_KEY,
  event: EVENT_PRIMARY_KEY,
  message: MESSAGE_PRIMARY_KEY,
  project: PROJECT_PRIMARY_KEY,
  raw_record: RAW_RECORD_PRIMARY_KEY,
  search_doc: SEARCH_DOC_PRIMARY_KEY,
  session: SESSION_PRIMARY_KEY,
  source_file: SOURCE_FILE_PRIMARY_KEY,
  tool_call: TOOL_CALL_PRIMARY_KEY,
  tool_result: TOOL_RESULT_PRIMARY_KEY,
  turn: TURN_PRIMARY_KEY,
} as const satisfies Record<CanonicalEntityType, string>
