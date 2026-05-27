// Parquet compaction trigger policy.
//
// Compaction is a derived-layer concern: the bundle's canonical Merkle
// leaves are over row content, not file bytes, so merging many small
// epoch segments into a single compacted file per entity type does
// not change `bundleRoot`. The compaction worker uses this policy to
// decide when to fire at the end of a compile.

/** A segment in an epoch's Parquet projection. */
export interface SegmentRef {
  /** Path inside the bundle (informational only — policy is content-free). */
  path: string
  /** On-disk byte length. */
  byteLength: number
}

/** Anything strictly smaller than 32 MiB is "small" for compaction. */
export const SMALL_SEGMENT_BYTES = 32 * 1024 * 1024
/** Compact when there are more than this many small segments. */
export const COMPACTION_FILE_COUNT_TRIGGER = 32
/** Lower count trigger, paired with a total-byte ceiling. */
export const COMPACTION_LOW_COUNT_TRIGGER = 16
/** Total byte ceiling for the low-count trigger. */
export const COMPACTION_LOW_COUNT_BYTE_CEILING = 256 * 1024 * 1024

/** Reason returned by `compactionDecision` when compaction is fired. */
export type CompactionFireReason = 'file_count_trigger' | 'low_count_byte_ceiling'

export interface CompactionDecision {
  /** When `true`, the worker should fire compaction for this entity. */
  shouldFire: boolean
  reason: CompactionFireReason | null
  smallCount: number
  smallTotalBytes: number
}

/** Return whether compaction should fire for one entity type given
 *  the current set of segments in its Parquet projection. */
export function compactionDecision(segments: readonly SegmentRef[]): CompactionDecision {
  const small = segments.filter((s) => s.byteLength < SMALL_SEGMENT_BYTES)
  const smallTotalBytes = small.reduce((sum, s) => sum + s.byteLength, 0)
  if (small.length > COMPACTION_FILE_COUNT_TRIGGER) {
    return {
      shouldFire: true,
      reason: 'file_count_trigger',
      smallCount: small.length,
      smallTotalBytes,
    }
  }
  if (small.length > COMPACTION_LOW_COUNT_TRIGGER && smallTotalBytes < COMPACTION_LOW_COUNT_BYTE_CEILING) {
    return {
      shouldFire: true,
      reason: 'low_count_byte_ceiling',
      smallCount: small.length,
      smallTotalBytes,
    }
  }
  return {
    shouldFire: false,
    reason: null,
    smallCount: small.length,
    smallTotalBytes,
  }
}

/** Convenience boolean form mirroring the lane spec signature. */
export function shouldCompact(segments: readonly SegmentRef[]): boolean {
  return compactionDecision(segments).shouldFire
}
