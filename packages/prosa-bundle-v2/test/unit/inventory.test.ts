import { describe, expect, it } from 'vitest'

import { buildObjectInventory, buildProjectionInventory } from '../../src/epoch/inventory.js'

describe('buildObjectInventory', () => {
  it('merges CAS + raw_source object_ids, dedupes, and sorts ascending', () => {
    const cas = new Set([
      'blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ])
    const raw = new Set([
      'blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      // duplicate of one already in cas — must not produce a second entry.
      'blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ])
    const result = buildObjectInventory({ casObjects: cas, rawSourceContent: raw })
    expect(result.payload.totalObjects).toBe(3)
    expect(result.payload.objects.map((o) => o.object_id)).toEqual([
      'blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ])
    // CAS wins the origin tag when both inventories admit the same id.
    expect(result.payload.objects[0]?.origin).toBe('cas_object_pack')
    // Two runs over the same input produce the same root (deterministic).
    const second = buildObjectInventory({ casObjects: cas, rawSourceContent: raw })
    expect(second.objectSetRoot).toBe(result.objectSetRoot)
    expect(second.digest).toBe(result.digest)
  })

  it('emits an empty payload + non-empty root when both inventories are empty', () => {
    const r = buildObjectInventory({ casObjects: new Set(), rawSourceContent: new Set() })
    expect(r.payload.totalObjects).toBe(0)
    expect(r.payload.objects.length).toBe(0)
    expect(r.objectSetRoot).toMatch(/^[0-9a-f]{64}$/)
    expect(r.digest).toMatch(/^blake3:[0-9a-f]{64}$/)
  })
})

describe('buildProjectionInventory', () => {
  it('sums byte and row totals and stamps stable segment ids', () => {
    const r = buildProjectionInventory({
      segments: [
        {
          digest: 'blake3:0000000000000000111111111111111122222222222222223333333333333333',
          byteLength: 100,
          entityType: 'session',
        },
        {
          digest: 'blake3:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          byteLength: 200,
          entityType: 'message',
        },
      ],
      countsByEntity: { session: 5, message: 17 },
    })
    expect(r.payload.totalBytes).toBe(300)
    expect(r.payload.totalRows).toBe(22)
    // segmentId stays stable across runs.
    const again = buildProjectionInventory({
      segments: [
        {
          digest: 'blake3:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          byteLength: 200,
          entityType: 'message',
        },
        {
          digest: 'blake3:0000000000000000111111111111111122222222222222223333333333333333',
          byteLength: 100,
          entityType: 'session',
        },
      ],
      countsByEntity: { session: 5, message: 17 },
    })
    expect(again.digest).toBe(r.digest) // input order shouldn't matter (sort by digest)
  })
})
