import type { SourceTool } from '../common.js'

// SourceFileV2 is the projection-grain row that exposes a source-file entry
// (file path, content hash, raw-source pack location) for canonical lookups.
// The full per-store SourceStateV2 record is stored in the shard actor.
export const SOURCE_FILE_FIELDS = [
  'source_file_id',
  'source_tool',
  'path',
  'file_kind',
  'size_bytes',
  'mtime_ns',
  'content_hash',
  'object_id',
  'pack_digest',
  'stored_offset',
  'stored_length',
  'compression',
  'last_seen_epoch',
] as const

export type SourceFileV2 = {
  source_file_id: string
  source_tool: SourceTool
  path: string
  file_kind: string
  size_bytes: number
  mtime_ns: number | null
  content_hash: string
  object_id: string
  pack_digest: string
  stored_offset: number
  stored_length: number
  compression: 'zstd' | 'none'
  last_seen_epoch: number
}

export const SOURCE_FILE_PRIMARY_KEY: keyof SourceFileV2 = 'source_file_id'
