// Parquet projection segment listing tests.
//
// `listProjectionSegments(bundleRoot)` enumerates every
// `epochs/<n>/projection/*.parquet` file. Mirrors the planner's
// filtering rules (digit-prefixed epoch dirs only, skip
// `compact-<N>` dirs, drop non-`.parquet` files).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listProjectionSegments } from '../../src/compaction/segments.js'

async function plantSegment(bundleRoot: string, epoch: number, entityType: string, bytes: number) {
  const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${entityType}.parquet`), Buffer.alloc(bytes, 0xab))
}

describe('listProjectionSegments', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-segments-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns [] on a fresh bundle (no epochs/ directory)', async () => {
    expect(await listProjectionSegments(bundleRoot)).toEqual([])
  })

  it('returns [] when epoch dirs exist but contain no projection files', async () => {
    await mkdir(join(bundleRoot, 'epochs', '1'), { recursive: true })
    await mkdir(join(bundleRoot, 'epochs', '2', 'projection'), { recursive: true })
    expect(await listProjectionSegments(bundleRoot)).toEqual([])
  })

  it('enumerates every .parquet file across every numeric epoch', async () => {
    await plantSegment(bundleRoot, 1, 'sessions', 100)
    await plantSegment(bundleRoot, 1, 'messages', 200)
    await plantSegment(bundleRoot, 3, 'tool_calls', 300)

    const segments = await listProjectionSegments(bundleRoot)

    expect(segments).toHaveLength(3)
    expect(segments.map((s) => `${s.epoch}/${s.entityType}`)).toEqual(['1/messages', '1/sessions', '3/tool_calls'])
  })

  it('records byteLength, epoch, entityType, path, and absPath for each segment', async () => {
    await plantSegment(bundleRoot, 7, 'sessions', 512)

    const segments = await listProjectionSegments(bundleRoot)
    expect(segments).toHaveLength(1)
    const seg = segments[0]!
    expect(seg.epoch).toBe(7)
    expect(seg.entityType).toBe('sessions')
    expect(seg.byteLength).toBe(512)
    expect(seg.path).toBe(`epochs${sep}7${sep}projection${sep}sessions.parquet`)
    expect(seg.absPath).toBe(join(bundleRoot, 'epochs', '7', 'projection', 'sessions.parquet'))
  })

  it('skips `compact-<N>` directories (already-compacted output is not relisted)', async () => {
    await plantSegment(bundleRoot, 1, 'sessions', 100)
    // Plant a compact-<NNNN> dir with its own projection content.
    const compactDir = join(bundleRoot, 'epochs', 'compact-0001', 'projection')
    await mkdir(compactDir, { recursive: true })
    await writeFile(join(compactDir, 'sessions.compacted.parquet'), 'compacted bytes')

    const segments = await listProjectionSegments(bundleRoot)

    expect(segments).toHaveLength(1)
    expect(segments[0]!.epoch).toBe(1)
    // The compacted output is not in the result.
    expect(segments.find((s) => s.path.includes('compact-'))).toBeUndefined()
  })

  it('ignores non-numeric epoch directories (e.g. typos / partial dirs)', async () => {
    await plantSegment(bundleRoot, 2, 'sessions', 100)
    // Stray non-numeric dir; the planner skips it and so does this listing.
    const strayDir = join(bundleRoot, 'epochs', 'tmp_partial', 'projection')
    await mkdir(strayDir, { recursive: true })
    await writeFile(join(strayDir, 'sessions.parquet'), 'stray')

    const segments = await listProjectionSegments(bundleRoot)

    expect(segments).toHaveLength(1)
    expect(segments[0]!.epoch).toBe(2)
  })

  it('drops files whose names do not end in `.parquet`', async () => {
    await plantSegment(bundleRoot, 1, 'sessions', 100)
    const dir = join(bundleRoot, 'epochs', '1', 'projection')
    await writeFile(join(dir, 'README.md'), 'docs')
    await writeFile(join(dir, 'sessions.arrow'), 'wrong format')
    await writeFile(join(dir, 'sessions.parquet.tmp'), 'stale temp')

    const segments = await listProjectionSegments(bundleRoot)

    expect(segments.map((s) => s.entityType)).toEqual(['sessions'])
  })

  it('returns segments sorted by (epoch, entityType) ascending', async () => {
    // Plant in deliberately unsorted order; expect ascending output.
    await plantSegment(bundleRoot, 3, 'messages', 100)
    await plantSegment(bundleRoot, 1, 'sessions', 100)
    await plantSegment(bundleRoot, 3, 'sessions', 100)
    await plantSegment(bundleRoot, 1, 'messages', 100)
    await plantSegment(bundleRoot, 0, 'tool_calls', 100)

    const segments = await listProjectionSegments(bundleRoot)

    expect(segments.map((s) => `${s.epoch}/${s.entityType}`)).toEqual([
      '0/tool_calls',
      '1/messages',
      '1/sessions',
      '3/messages',
      '3/sessions',
    ])
  })

  it('handles a single epoch with many segments deterministically', async () => {
    for (const entity of ['sessions', 'messages', 'tool_calls', 'turns', 'artifacts']) {
      await plantSegment(bundleRoot, 1, entity, 100)
    }
    const segments = await listProjectionSegments(bundleRoot)
    expect(segments.map((s) => s.entityType)).toEqual(['artifacts', 'messages', 'sessions', 'tool_calls', 'turns'])
  })
})
