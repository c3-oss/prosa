import type { Confidence, EdgeSource, EdgeType } from '../common.js'

export const EDGE_FIELDS = [
  'edge_id',
  'src_type',
  'src_id',
  'dst_type',
  'dst_id',
  'edge_type',
  'confidence',
  'source',
  'raw_record_id',
  'metadata_object_id',
] as const

export type EdgeV2 = {
  edge_id: string
  src_type: string
  src_id: string
  dst_type: string
  dst_id: string
  edge_type: EdgeType
  confidence: Confidence
  source: EdgeSource
  raw_record_id: string | null
  metadata_object_id: string | null
}

export const EDGE_PRIMARY_KEY: keyof EdgeV2 = 'edge_id'
