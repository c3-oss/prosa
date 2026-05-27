import type { Confidence, SourceTool } from '../common.js'

// RawRecordV2 is the projection-grain handle for an individual logical record
// preserved verbatim from the source. The bytes live in raw-source packs;
// this row is the indexable row a session/turn/event points at.
//
// Per CQ-006, the row carries enough locator and provenance fields to
// reconstruct the preserved record byte-for-byte from its raw-source pack
// entry, and to derive `raw_record_id` deterministically from
// `(source_file_id, ordinal, record_kind)`.
export const RAW_RECORD_FIELDS = [
  'raw_record_id',
  'source_tool',
  'source_file_id',
  'record_kind',
  'ordinal',
  'logical_offset',
  'logical_length',
  'line_no',
  'json_pointer',
  'parser_status',
  'confidence',
  'content_hash',
  'object_id',
  'decoded_object_id',
  'created_at',
] as const

export type RawRecordKind =
  | 'session_jsonl_line'
  | 'session_sqlite_row'
  | 'session_protobuf_frame'
  | 'artifact_blob'
  | 'project_meta'
  | 'generic'

export type ParserStatus = 'parsed' | 'parsed_with_warnings' | 'unparseable' | 'binary_only'

export type RawRecordV2 = {
  raw_record_id: string
  source_tool: SourceTool
  source_file_id: string
  // Canonical kind label used in raw_record_id derivation (CANONICAL.md
  // rule 13). Adding a new kind requires an ADR; existing kinds must not
  // change spelling.
  record_kind: RawRecordKind
  // 0-based position of this record within the source file. Combined with
  // source_file_id, it is the idempotency key seed.
  ordinal: number
  // Byte-offset locator within the source file (or null for protocols that
  // do not expose offsets; the parser then must record line_no or
  // json_pointer).
  logical_offset: number | null
  logical_length: number | null
  // Line-number locator (1-based) for JSONL-style sources; null when not
  // applicable.
  line_no: number | null
  // JSON pointer (RFC 6901) for SQLite/JSON sources that point into a
  // larger structure; null when not applicable.
  json_pointer: string | null
  parser_status: ParserStatus
  confidence: Confidence
  // BLAKE3 over uncompressed original bytes of the record (the canonical
  // object identity — see CANONICAL.md rule 6 ObjectId).
  content_hash: string
  // ObjectId of the preserved raw bytes (typically the same as
  // content_hash; surfaced as its own column because object stores key by
  // it, not by the legacy content_hash column).
  object_id: string
  // When the importer decoded the raw bytes into a JSON structure that is
  // independently stored as a CAS object, this is its ObjectId; null when
  // the record was kept opaque.
  decoded_object_id: string | null
  created_at: string
}

export const RAW_RECORD_PRIMARY_KEY: keyof RawRecordV2 = 'raw_record_id'
