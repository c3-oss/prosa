import type { SourceTool } from './common.js'

export type SourceStateV2 = {
  source_file_id: string
  source_tool: SourceTool
  path: string
  size_bytes: number
  mtime_ns: number | null
  content_hash: string
  object_id: string
  raw_source_location: {
    pack_digest: string
    stored_offset: number
    stored_length: number
    compression: 'zstd' | 'none'
  }
  last_seen_epoch: number
}
