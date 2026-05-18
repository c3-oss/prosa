// Per-entity per-field "kind" metadata used by `merkleLeaf` to enforce
// canonical normalization (CANONICAL.md rules 5 and 6).
//
// Kinds:
//   - 'timestamp'  : RFC3339 UTC ms-precision; matches `canonicalTimestamp`'s
//                    output regex. Non-canonical inputs are rejected.
//   - 'id'         : opaque lowercase identifier, [A-Za-z0-9_:-]+. Uppercase
//                    or whitespace is rejected. (We allow upper letters in
//                    the regex only for legacy identifiers; new IDs MUST be
//                    lowercase. See note below.)
//   - 'tagged_hash': `blake3:<64-hex-lower>`. Used for *_object_id, *_hash
//                    when the importer emits the algorithm-tagged form, and
//                    for raw-record content/object identity.
//   - 'hex_hash'   : bare 64-char lowercase hex. Used for Merkle roots.
//   - 'enum'       : free string from a small enumeration; validated as
//                    plain string (kind kept for documentation).
//   - 'string'     : free string; encoded with NFC normalization only.
//   - 'integer'    : safe integer or bigint.
//   - 'boolean'    : true/false.
//
// Note: existing fixture identifiers contain `_` and lowercase letters, e.g.
// `ses_0001`. The id regex below accepts those. We do NOT silently lowercase
// — IDs are rejected if they contain an uppercase ASCII letter, so producers
// must canonicalize at ingest.

import type { CanonicalEntityType } from './common.js'

export type FieldKind = 'timestamp' | 'id' | 'tagged_hash' | 'hex_hash' | 'enum' | 'string' | 'integer' | 'boolean'

type EntityFieldKindMap = Readonly<Record<string, FieldKind>>

// Field-kind metadata per entity. Field names not listed default to 'string'.
// A field with `null` allowed still uses the listed kind when non-null.
export const ENTITY_FIELD_KINDS: Record<CanonicalEntityType, EntityFieldKindMap> = {
  artifact: {
    artifact_id: 'id',
    session_id: 'id',
    project_id: 'id',
    source_tool: 'enum',
    kind: 'enum',
    path: 'string',
    logical_path: 'string',
    object_id: 'id',
    text_object_id: 'id',
    mime_type: 'string',
    size_bytes: 'integer',
    created_ts: 'timestamp',
    raw_record_id: 'id',
  },
  content_block: {
    block_id: 'id',
    message_id: 'id',
    event_id: 'id',
    session_id: 'id',
    ordinal: 'integer',
    block_type: 'enum',
    text_object_id: 'id',
    text_inline: 'string',
    mime_type: 'string',
    token_count: 'integer',
    is_error: 'boolean',
    is_redacted: 'boolean',
    visibility: 'enum',
    raw_record_id: 'id',
  },
  edge: {
    edge_id: 'id',
    src_type: 'enum',
    src_id: 'id',
    dst_type: 'enum',
    dst_id: 'id',
    edge_type: 'enum',
    confidence: 'enum',
    source: 'enum',
    raw_record_id: 'id',
    metadata_object_id: 'id',
  },
  event: {
    event_id: 'id',
    session_id: 'id',
    turn_id: 'id',
    source_event_id: 'id',
    event_type: 'enum',
    source_type: 'enum',
    subtype: 'enum',
    timestamp: 'timestamp',
    ordinal: 'integer',
    actor: 'enum',
    payload_object_id: 'id',
    raw_record_id: 'id',
    confidence: 'enum',
    is_derived: 'boolean',
  },
  message: {
    message_id: 'id',
    session_id: 'id',
    turn_id: 'id',
    event_id: 'id',
    source_message_id: 'id',
    role: 'enum',
    author_name: 'string',
    model: 'string',
    timestamp: 'timestamp',
    ordinal: 'integer',
    parent_message_id: 'id',
    request_id: 'id',
    status: 'enum',
    raw_record_id: 'id',
  },
  project: {
    project_id: 'id',
    canonical_path: 'string',
    path_hash: 'string',
    source_tool: 'enum',
    source_project_id: 'id',
    display_name: 'string',
    created_at: 'timestamp',
  },
  raw_record: {
    raw_record_id: 'id',
    source_tool: 'enum',
    source_file_id: 'id',
    record_kind: 'enum',
    ordinal: 'integer',
    logical_offset: 'integer',
    logical_length: 'integer',
    line_no: 'integer',
    json_pointer: 'string',
    parser_status: 'enum',
    confidence: 'enum',
    content_hash: 'tagged_hash',
    object_id: 'id',
    decoded_object_id: 'id',
    created_at: 'timestamp',
  },
  search_doc: {
    doc_id: 'id',
    entity_type: 'enum',
    entity_id: 'id',
    session_id: 'id',
    project_id: 'id',
    timestamp: 'timestamp',
    role: 'enum',
    tool_name: 'string',
    canonical_tool_type: 'enum',
    field_kind: 'enum',
    errors_only: 'boolean',
    text: 'string',
  },
  session: {
    session_id: 'id',
    source_tool: 'enum',
    source_session_id: 'id',
    project_id: 'id',
    parent_session_id: 'id',
    parent_resolution: 'enum',
    is_subagent: 'boolean',
    agent_role: 'enum',
    agent_nickname: 'string',
    title: 'string',
    summary: 'string',
    start_ts: 'timestamp',
    end_ts: 'timestamp',
    cwd_initial: 'string',
    git_branch_initial: 'string',
    model_first: 'string',
    model_last: 'string',
    status: 'enum',
    timeline_confidence: 'enum',
    raw_record_id: 'id',
  },
  source_file: {
    source_file_id: 'id',
    source_tool: 'enum',
    path: 'string',
    file_kind: 'enum',
    size_bytes: 'integer',
    mtime_ns: 'integer',
    content_hash: 'tagged_hash',
    object_id: 'id',
    pack_digest: 'tagged_hash',
    stored_offset: 'integer',
    stored_length: 'integer',
    compression: 'enum',
    last_seen_epoch: 'integer',
  },
  tool_call: {
    tool_call_id: 'id',
    session_id: 'id',
    turn_id: 'id',
    message_id: 'id',
    event_id: 'id',
    source_call_id: 'id',
    tool_name: 'string',
    canonical_tool_type: 'enum',
    args_object_id: 'id',
    command: 'string',
    cwd: 'string',
    path: 'string',
    query: 'string',
    timestamp_start: 'timestamp',
    timestamp_end: 'timestamp',
    status: 'enum',
    raw_record_id: 'id',
  },
  tool_result: {
    tool_result_id: 'id',
    tool_call_id: 'id',
    session_id: 'id',
    message_id: 'id',
    event_id: 'id',
    source_call_id: 'id',
    status: 'enum',
    is_error: 'boolean',
    exit_code: 'integer',
    duration_ms: 'integer',
    stdout_object_id: 'id',
    stderr_object_id: 'id',
    output_object_id: 'id',
    preview: 'string',
    raw_record_id: 'id',
  },
  turn: {
    turn_id: 'id',
    session_id: 'id',
    source_turn_id: 'id',
    ordinal: 'integer',
    start_ts: 'timestamp',
    end_ts: 'timestamp',
    model: 'string',
    cwd: 'string',
    git_branch: 'string',
    approval_policy: 'enum',
    sandbox_policy: 'enum',
    effort: 'enum',
    raw_record_id: 'id',
  },
}
