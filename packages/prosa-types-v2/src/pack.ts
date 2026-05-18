import type { SourceTool } from './common.js'

export type PackKind = 'cas_object_pack' | 'raw_source_pack'

export type PackRef = {
  pack_digest: string
  kind: PackKind
  entry_count: number
  byte_length: number
  object_set_root: string
  standalone_large_object: boolean
}

export type RawSourcePackRef = PackRef & {
  kind: 'raw_source_pack'
}

export type RawSourcePackEntryV2 = {
  source_file_id: string
  source_tool: SourceTool
  path: string
  file_kind: string
  size_bytes: number
  mtime_ns: number | null
  content_hash: string
  object_id: string

  stored_offset: number
  stored_length: number
  compression: 'zstd' | 'none'
  uncompressed_hash: string
  uncompressed_size: number
  stored_hash: string

  workspace_hint?: string | null
}
