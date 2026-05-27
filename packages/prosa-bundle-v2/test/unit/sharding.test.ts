import { describe, expect, it } from 'vitest'

import { SHARD_COUNT, shardOf } from '../../src/shard/sharding.js'

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('shardOf', () => {
  it('is deterministic for identical inputs', () => {
    const a = shardOf('session', bytes('ses_001'))
    const b = shardOf('session', bytes('ses_001'))
    expect(a).toBe(b)
  })

  it('returns an integer in [0, SHARD_COUNT)', () => {
    for (let i = 0; i < 100; i++) {
      const s = shardOf('session', bytes(`ses_${i}`))
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(SHARD_COUNT)
    }
  })

  it('distributes keys across shards', () => {
    const buckets = Array.from({ length: SHARD_COUNT }, () => 0)
    for (let i = 0; i < 1000; i++) {
      buckets[shardOf('object', bytes(`obj_${i}`))]!++
    }
    for (const b of buckets) {
      // With 1000 keys across 4 shards, each shard should get at least
      // ~150 (chi-square sanity).
      expect(b).toBeGreaterThan(150)
    }
  })

  it('treats different keyspaces as different domains', () => {
    // The same canonical key in different keyspaces does NOT always map
    // to the same shard — domain separation is the point.
    const a = shardOf('session', bytes('alpha'))
    const b = shardOf('object', bytes('alpha'))
    // There's no guarantee they differ for one input, but across many
    // inputs the distributions must be independent.
    let diff = 0
    for (let i = 0; i < 100; i++) {
      const k = bytes(`k_${i}`)
      if (shardOf('session', k) !== shardOf('object', k)) diff++
    }
    expect(diff).toBeGreaterThan(50)
    // suppress "unused" lint complaints
    expect(typeof a === 'number' && typeof b === 'number').toBe(true)
  })
})
