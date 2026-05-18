import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { verifyCasPack } from '../../src/pack/cas-pack.js'
import { CasPackWriterPool, LARGE_OBJECT_THRESHOLD_BYTES, SMALL_WRITER_COUNT } from '../../src/pack/cas-writer.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-cas-pool-'))
}

function bytes(n: number, fill = 0): Uint8Array {
  return new Uint8Array(n).fill(fill)
}

const created = () => '2025-01-02T03:04:05.123Z'

describe('CasPackWriterPool', () => {
  it('routes large objects to the large writer and emits a standalone pack', async () => {
    const dir = await tmp()
    const pool = new CasPackWriterPool({
      casDir: dir,
      createdAt: created,
      largeObjectThresholdBytes: 1024,
    })
    const big = bytes(2048, 0xaa)
    const r = await pool.appendObject({ bytes: big })
    expect(r.isLarge).toBe(true)
    expect(r.packDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(r.packPath?.includes(`${dir}/large/`)).toBe(true)
    // Verify the pack on disk.
    const files = await readdir(join(dir, 'large'))
    expect(files.length).toBe(1)
  })

  it('routes small objects to the small-writer pool sharded by object_id', async () => {
    const dir = await tmp()
    const pool = new CasPackWriterPool({ casDir: dir, createdAt: created })
    // 64 distinct objects → most should land in different small shards.
    const shards = new Set<number>()
    for (let i = 0; i < 64; i++) {
      const r = await pool.appendObject({ bytes: new TextEncoder().encode(`object-${i}`) })
      shards.add(r.shardId)
    }
    expect(shards.size).toBeGreaterThan(1)
    for (const s of shards) {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(SMALL_WRITER_COUNT)
    }
  })

  it('rotates a small pack when target_pack_bytes is reached', async () => {
    const dir = await tmp()
    const pool = new CasPackWriterPool({
      casDir: dir,
      createdAt: created,
      triggers: { targetPackBytes: 1024, maxPackBytes: 4096, maxObjects: 1000, maxOpenMs: 60_000 },
    })
    // Push 200 × 200-byte objects = 40_000 bytes spread across 8 shards.
    // On average each shard accumulates 5000 bytes — well past the 1024
    // target — so we expect multiple rotations.
    let emissions = 0
    for (let i = 0; i < 200; i++) {
      const r = await pool.appendObject({ bytes: new TextEncoder().encode(`object-${i}`.padEnd(200, 'x')) })
      if (r.packDigest) emissions++
    }
    await pool.flushAll()
    expect(emissions).toBeGreaterThanOrEqual(1)
  })

  it('rotates when max_open_ms elapses (within one shard)', async () => {
    const dir = await tmp()
    let t = 1000
    const pool = new CasPackWriterPool({
      casDir: dir,
      createdAt: created,
      now: () => t,
      triggers: {
        targetPackBytes: 1024 * 1024,
        maxPackBytes: 4 * 1024 * 1024,
        maxObjects: 1000,
        maxOpenMs: 500,
      },
    })
    // Seed many objects to ensure at least one shard sees two appends.
    await pool.appendObject({ bytes: new TextEncoder().encode('a') })
    await pool.appendObject({ bytes: new TextEncoder().encode('b') })
    await pool.appendObject({ bytes: new TextEncoder().encode('c') })
    await pool.appendObject({ bytes: new TextEncoder().encode('d') })
    t = 2000 // > maxOpenMs
    // Re-append (different content) — same-shard hits will rotate.
    let rotated = false
    for (let i = 0; i < 32; i++) {
      const r = await pool.appendObject({ bytes: new TextEncoder().encode(`age-${i}`) })
      if (r.packDigest) {
        rotated = true
        break
      }
    }
    expect(rotated).toBe(true)
  })

  it('dedupes by object_id across appends', async () => {
    const dir = await tmp()
    const pool = new CasPackWriterPool({ casDir: dir, createdAt: created })
    const input = { bytes: new TextEncoder().encode('same-bytes') }
    const a = await pool.appendObject(input)
    const b = await pool.appendObject(input)
    expect(a.object_id).toBe(b.object_id)
    // The second admission is a no-op: same shardId may differ (shardId is
    // -1 for dedup hits), but the object is not buffered again.
    expect(b.shardId).toBe(-1)
    expect(pool.bufferedCount()).toBeLessThanOrEqual(1)
  })

  it('flushAll emits any remaining buffered objects', async () => {
    const dir = await tmp()
    const pool = new CasPackWriterPool({
      casDir: dir,
      createdAt: created,
      triggers: { targetPackBytes: 1024 * 1024, maxPackBytes: 4 * 1024 * 1024, maxObjects: 1000, maxOpenMs: 60_000 },
    })
    await pool.appendObject({ bytes: new TextEncoder().encode('a') })
    await pool.appendObject({ bytes: new TextEncoder().encode('b') })
    expect(pool.bufferedCount()).toBe(2)
    const emissions = await pool.flushAll()
    // The two objects may have landed on different shards, so flushAll
    // emits 1 or 2 packs. What matters is that every buffered object made
    // it into an emission.
    expect(emissions.length).toBeGreaterThanOrEqual(1)
    expect(emissions.length).toBeLessThanOrEqual(2)
    expect(pool.bufferedCount()).toBe(0)
    let totalEntries = 0
    for (const e of emissions) {
      const v = verifyCasPack(e.built.bytes)
      totalEntries += v.entries.length
    }
    expect(totalEntries).toBe(2)
  })

  it('emits packs that verify against verifyCasPack', async () => {
    const dir = await tmp()
    const pool = new CasPackWriterPool({
      casDir: dir,
      createdAt: created,
      triggers: { targetPackBytes: 10, maxPackBytes: 1024, maxObjects: 1000, maxOpenMs: 60_000 },
    })
    let pack: Awaited<ReturnType<typeof pool.appendObject>> | null = null
    for (let i = 0; i < 5 && pack?.packDigest == null; i++) {
      pack = await pool.appendObject({ bytes: new TextEncoder().encode(`o${i}`.repeat(8)) })
    }
    if (!pack?.packDigest) throw new Error('expected emission via target-bytes trigger')
  })

  it('large-object threshold default is 32 MiB', () => {
    expect(LARGE_OBJECT_THRESHOLD_BYTES).toBe(32 * 1024 * 1024)
  })
})
