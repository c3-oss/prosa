// Parquet compaction trigger policy tests.

import { describe, expect, it } from 'vitest'

import {
  COMPACTION_FILE_COUNT_TRIGGER,
  COMPACTION_LOW_COUNT_BYTE_CEILING,
  COMPACTION_LOW_COUNT_TRIGGER,
  SMALL_SEGMENT_BYTES,
  type SegmentRef,
  compactionDecision,
  shouldCompact,
} from '../../src/compaction/policy.js'

function smallSegments(count: number, byteLength: number): SegmentRef[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `epochs/${i + 1}/projection/messages.parquet`,
    byteLength,
  }))
}

describe('compactionDecision', () => {
  it('does not fire when there are few small segments', () => {
    const d = compactionDecision(smallSegments(5, 4 * 1024 * 1024))
    expect(d.shouldFire).toBe(false)
    expect(d.reason).toBeNull()
    expect(d.smallCount).toBe(5)
  })

  it('fires on the file-count trigger when more than 32 small segments exist', () => {
    const d = compactionDecision(smallSegments(COMPACTION_FILE_COUNT_TRIGGER + 1, 4 * 1024 * 1024))
    expect(d.shouldFire).toBe(true)
    expect(d.reason).toBe('file_count_trigger')
  })

  it('fires on the low-count byte ceiling when 17–32 small files weigh under 256 MiB total', () => {
    const count = COMPACTION_LOW_COUNT_TRIGGER + 1
    const perFile = Math.floor((COMPACTION_LOW_COUNT_BYTE_CEILING - 1024) / count)
    const d = compactionDecision(smallSegments(count, perFile))
    expect(d.shouldFire).toBe(true)
    expect(d.reason).toBe('low_count_byte_ceiling')
    expect(d.smallTotalBytes).toBeLessThan(COMPACTION_LOW_COUNT_BYTE_CEILING)
  })

  it('does not fire when 17–32 small files weigh ≥ 256 MiB total', () => {
    const count = COMPACTION_LOW_COUNT_TRIGGER + 1
    const perFile = Math.ceil(COMPACTION_LOW_COUNT_BYTE_CEILING / count) + 1
    const d = compactionDecision(smallSegments(count, perFile))
    expect(d.shouldFire).toBe(false)
  })

  it('ignores large segments when evaluating "small file count"', () => {
    const segments: SegmentRef[] = [
      ...smallSegments(5, 4 * 1024 * 1024),
      { path: 'epochs/compact-1/projection/messages.compacted.parquet', byteLength: SMALL_SEGMENT_BYTES + 1 },
      { path: 'epochs/compact-2/projection/messages.compacted.parquet', byteLength: 512 * 1024 * 1024 },
    ]
    const d = compactionDecision(segments)
    expect(d.smallCount).toBe(5)
    expect(d.shouldFire).toBe(false)
  })

  it('shouldCompact mirrors compactionDecision.shouldFire', () => {
    expect(shouldCompact(smallSegments(5, 4 * 1024 * 1024))).toBe(false)
    expect(shouldCompact(smallSegments(COMPACTION_FILE_COUNT_TRIGGER + 1, 4 * 1024 * 1024))).toBe(true)
  })
})
