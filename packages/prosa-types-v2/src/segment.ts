import type { CanonicalEntityType, SegmentKind } from './common.js'

export type SegmentRef = {
  segmentId: string
  kind: SegmentKind
  digest: string
  logicalRoot: string
  compression: 'zstd' | 'none'
  byteLength: number

  entityType?: CanonicalEntityType
  rowCount?: number
  minKey?: string
  maxKey?: string
  minTimestamp?: string | null
  maxTimestamp?: string | null

  objectCount?: number
  objectSetRoot?: string
}
