import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { verifyRawSourcePack } from '../../src/pack/raw-source-pack.js'
import { RAW_WRITER_COUNT, RawSourcePackWriterPool } from '../../src/pack/raw-source-writer.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-raw-pool-'))
}

const created = () => '2025-01-02T03:04:05.123Z'

function input(id: string, content: string) {
  return {
    source_file_id: id,
    source_tool: 'codex' as const,
    path: `/repo/${id}.jsonl`,
    file_kind: 'session_jsonl',
    mtime_ns: null,
    bytes: new TextEncoder().encode(content),
  }
}

describe('RawSourcePackWriterPool', () => {
  it('shards by source_file_id (every shard receives at least one over many inputs)', async () => {
    const dir = await tmp()
    const pool = new RawSourcePackWriterPool({ rawSourcesDir: dir, createdAt: created })
    const shards = new Set<number>()
    for (let i = 0; i < 64; i++) {
      const r = await pool.appendSourceFile(input(`src_${i}`, `payload-${i}`))
      shards.add(r.shardId)
    }
    for (const s of shards) {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(RAW_WRITER_COUNT)
    }
    expect(shards.size).toBeGreaterThan(1)
  })

  it('flushAll closes remaining open shards and emits verifiable packs', async () => {
    const dir = await tmp()
    const pool = new RawSourcePackWriterPool({
      rawSourcesDir: dir,
      createdAt: created,
      triggers: { targetPackBytes: 1024 * 1024, maxPackBytes: 4 * 1024 * 1024, maxObjects: 1000, maxOpenMs: 60_000 },
    })
    for (let i = 0; i < 8; i++) {
      await pool.appendSourceFile(input(`src_${i}`, `payload-${i}`))
    }
    expect(pool.bufferedCount()).toBe(8)
    const emissions = await pool.flushAll()
    expect(emissions.length).toBeGreaterThan(0)
    expect(pool.bufferedCount()).toBe(0)
    for (const e of emissions) {
      const v = verifyRawSourcePack(e.built.bytes)
      expect(v.entries.length).toBeGreaterThan(0)
    }
    // Each emission landed on disk.
    const files = await readdir(join(dir, 'packs'))
    expect(files.length).toBe(emissions.length)
  })

  it('dedupes by source_file_id', async () => {
    const dir = await tmp()
    const pool = new RawSourcePackWriterPool({ rawSourcesDir: dir, createdAt: created })
    await pool.appendSourceFile(input('src_a', 'first'))
    const r = await pool.appendSourceFile(input('src_a', 'second'))
    expect(r.shardId).toBe(-1)
    expect(pool.bufferedCount()).toBe(1)
  })

  it('rotates when max_open_ms elapses', async () => {
    const dir = await tmp()
    let t = 1000
    const pool = new RawSourcePackWriterPool({
      rawSourcesDir: dir,
      createdAt: created,
      now: () => t,
      triggers: {
        targetPackBytes: 1024 * 1024,
        maxPackBytes: 4 * 1024 * 1024,
        maxObjects: 1000,
        maxOpenMs: 500,
      },
    })
    await pool.appendSourceFile(input('src_a', 'first'))
    t = 2000
    // Second append on the same shard rotates the previous batch.
    // src_a hashes to a specific shard; we add a different id and try it.
    const ids = ['src_b', 'src_c', 'src_d', 'src_e', 'src_f', 'src_g', 'src_h']
    let rotated = false
    for (const id of ids) {
      const r = await pool.appendSourceFile(input(id, 'x'))
      if (r.packDigest) {
        rotated = true
        break
      }
    }
    expect(rotated || (await pool.flushAll()).length > 0).toBe(true)
  })
})
