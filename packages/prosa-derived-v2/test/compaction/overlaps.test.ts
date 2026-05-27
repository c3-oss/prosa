// Tests for `detectCompactionOverlaps`.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildCompactManifestV2, writeCompactManifestV2 } from '../../src/compaction/manifest.js'
import { detectCompactionOverlaps } from '../../src/compaction/overlaps.js'
import type { CompactionPlan } from '../../src/compaction/planner.js'

const GENERATED_AT = '2026-05-19T12:00:00.000Z'

function planFor(
  seq: number,
  entityType: string,
  supersededSegments: Array<{ epoch: number; byteLength: number }>,
): CompactionPlan {
  return {
    empty: false,
    entities: [
      {
        entityType,
        reason: 'low_count_byte_ceiling',
        outputPath: `epochs${sep}compact-${String(seq).padStart(4, '0')}${sep}projection${sep}${entityType}.compacted.parquet`,
        totalBytesIn: supersededSegments.reduce((s, x) => s + x.byteLength, 0),
        segmentsToMerge: supersededSegments.map((seg) => ({
          epoch: seg.epoch,
          path: `epochs${sep}${seg.epoch}${sep}projection${sep}${entityType}.parquet`,
          byteLength: seg.byteLength,
        })),
      },
    ],
  }
}

describe('detectCompactionOverlaps', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-overlaps-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns `[]` for a bundle with no persisted manifests', async () => {
    expect(await detectCompactionOverlaps(bundleRoot)).toEqual([])
  })

  it('returns `[]` when each manifest claims a disjoint set of source segments (healthy case)', async () => {
    const planA = planFor(1, 'sessions', [
      { epoch: 1, byteLength: 1024 },
      { epoch: 2, byteLength: 1024 },
    ])
    const planB = planFor(2, 'sessions', [
      { epoch: 3, byteLength: 1024 },
      { epoch: 4, byteLength: 1024 },
    ])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planA, generatedAt: GENERATED_AT }))
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planB, generatedAt: GENERATED_AT }))

    expect(await detectCompactionOverlaps(bundleRoot)).toEqual([])
  })

  it('flags a source path claimed by two manifests with both compaction_seqs sorted ascending', async () => {
    const planA = planFor(1, 'sessions', [
      { epoch: 1, byteLength: 1024 },
      { epoch: 2, byteLength: 1024 },
    ])
    // planB writes a manifest that also lists epoch=2 — same
    // bundle-relative path — even though it is for a later seq.
    // This is the corruption signal we want to catch.
    const planB = planFor(2, 'sessions', [
      { epoch: 2, byteLength: 1024 },
      { epoch: 3, byteLength: 1024 },
    ])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planA, generatedAt: GENERATED_AT }))
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planB, generatedAt: GENERATED_AT }))

    const overlaps = await detectCompactionOverlaps(bundleRoot)
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]!.path).toBe(`epochs${sep}2${sep}projection${sep}sessions.parquet`)
    expect(overlaps[0]!.claimed_by).toEqual([
      { compaction_seq: 1, entity_type: 'sessions' },
      { compaction_seq: 2, entity_type: 'sessions' },
    ])
  })

  it('flags multiple distinct overlapping paths sorted by path ascending', async () => {
    // Three manifests, overlapping on two paths:
    //   epochs/2/projection/sessions.parquet  → claimed by seq 1 and seq 3
    //   epochs/5/projection/messages.parquet  → claimed by seq 2 and seq 3
    const planA = planFor(1, 'sessions', [
      { epoch: 1, byteLength: 1024 },
      { epoch: 2, byteLength: 1024 },
    ])
    const planB = planFor(2, 'messages', [{ epoch: 5, byteLength: 1024 }])
    const planC: CompactionPlan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'low_count_byte_ceiling',
          outputPath: `epochs${sep}compact-0003${sep}projection${sep}sessions.compacted.parquet`,
          totalBytesIn: 1024,
          segmentsToMerge: [
            { epoch: 2, path: `epochs${sep}2${sep}projection${sep}sessions.parquet`, byteLength: 1024 },
          ],
        },
        {
          entityType: 'messages',
          reason: 'low_count_byte_ceiling',
          outputPath: `epochs${sep}compact-0003${sep}projection${sep}messages.compacted.parquet`,
          totalBytesIn: 1024,
          segmentsToMerge: [
            { epoch: 5, path: `epochs${sep}5${sep}projection${sep}messages.parquet`, byteLength: 1024 },
          ],
        },
      ],
    }
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planA, generatedAt: GENERATED_AT }))
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planB, generatedAt: GENERATED_AT }))
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planC, generatedAt: GENERATED_AT }))

    const overlaps = await detectCompactionOverlaps(bundleRoot)
    expect(overlaps).toHaveLength(2)
    // Sorted by path ascending; epochs/2/... sorts before epochs/5/...
    expect(overlaps[0]!.path).toBe(`epochs${sep}2${sep}projection${sep}sessions.parquet`)
    expect(overlaps[0]!.claimed_by.map((c) => c.compaction_seq)).toEqual([1, 3])
    expect(overlaps[1]!.path).toBe(`epochs${sep}5${sep}projection${sep}messages.parquet`)
    expect(overlaps[1]!.claimed_by.map((c) => c.compaction_seq)).toEqual([2, 3])
  })

  it('three-way overlap: the same path claimed by three manifests surfaces with all three seqs sorted ascending', async () => {
    const planA = planFor(1, 'sessions', [{ epoch: 7, byteLength: 1024 }])
    const planB = planFor(2, 'sessions', [{ epoch: 7, byteLength: 1024 }])
    const planC = planFor(3, 'sessions', [{ epoch: 7, byteLength: 1024 }])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planA, generatedAt: GENERATED_AT }))
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planB, generatedAt: GENERATED_AT }))
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planC, generatedAt: GENERATED_AT }))

    const overlaps = await detectCompactionOverlaps(bundleRoot)
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]!.claimed_by.map((c) => c.compaction_seq)).toEqual([1, 2, 3])
  })
})
