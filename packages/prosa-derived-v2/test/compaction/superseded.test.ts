// Tests for `listSupersededSegmentsFromManifests` and
// `summariseSupersededSegments`.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildCompactManifestV2, writeCompactManifestV2 } from '../../src/compaction/manifest.js'
import type { CompactionPlan } from '../../src/compaction/planner.js'
import { listSupersededSegmentsFromManifests, summariseSupersededSegments } from '../../src/compaction/superseded.js'

const GENERATED_AT = '2026-05-19T12:00:00.000Z'

function planFor(
  seq: number,
  entities: Array<{
    entityType: string
    reason: 'file_count_trigger' | 'low_count_byte_ceiling'
    superseded: Array<{ epoch: number; relative_segment: string; byteLength: number }>
  }>,
): CompactionPlan {
  return {
    empty: false,
    entities: entities.map((e) => ({
      entityType: e.entityType,
      reason: e.reason,
      outputPath: `epochs${sep}compact-${String(seq).padStart(4, '0')}${sep}projection${sep}${e.entityType}.compacted.parquet`,
      totalBytesIn: e.superseded.reduce((s, x) => s + x.byteLength, 0),
      segmentsToMerge: e.superseded.map((seg) => ({
        epoch: seg.epoch,
        path: `epochs${sep}${seg.epoch}${sep}projection${sep}${seg.relative_segment}`,
        byteLength: seg.byteLength,
      })),
    })),
  }
}

describe('listSupersededSegmentsFromManifests', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-superseded-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns [] for a bundle without an epochs/ directory', async () => {
    expect(await listSupersededSegmentsFromManifests(bundleRoot)).toEqual([])
  })

  it('returns [] when epochs/ exists but has no compact-<NNNN>/ subdirectories', async () => {
    await mkdir(join(bundleRoot, 'epochs', '1'), { recursive: true })
    expect(await listSupersededSegmentsFromManifests(bundleRoot)).toEqual([])
  })

  it('aggregates superseded segments across a single persisted manifest', async () => {
    const plan = planFor(1, [
      {
        entityType: 'sessions',
        reason: 'low_count_byte_ceiling',
        superseded: [
          { epoch: 1, relative_segment: 'sessions.parquet', byteLength: 1_024 },
          { epoch: 2, relative_segment: 'sessions.parquet', byteLength: 2_048 },
        ],
      },
    ])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))

    const result = await listSupersededSegmentsFromManifests(bundleRoot)
    expect(result).toHaveLength(2)
    expect(result.map((r) => `${r.compaction_seq}/${r.entity_type}/${r.epoch}`)).toEqual([
      '1/sessions/1',
      '1/sessions/2',
    ])
    expect(result.map((r) => r.byte_length)).toEqual([1_024, 2_048])
  })

  it('aggregates across multiple persisted manifests in deterministic seq-major order', async () => {
    const planSeq1 = planFor(1, [
      {
        entityType: 'sessions',
        reason: 'low_count_byte_ceiling',
        superseded: [{ epoch: 1, relative_segment: 'sessions.parquet', byteLength: 100 }],
      },
    ])
    const planSeq3 = planFor(3, [
      {
        entityType: 'messages',
        reason: 'file_count_trigger',
        superseded: [
          { epoch: 5, relative_segment: 'messages.parquet', byteLength: 300 },
          { epoch: 6, relative_segment: 'messages.parquet', byteLength: 400 },
        ],
      },
      {
        entityType: 'sessions',
        reason: 'low_count_byte_ceiling',
        superseded: [{ epoch: 5, relative_segment: 'sessions.parquet', byteLength: 200 }],
      },
    ])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planSeq3, generatedAt: GENERATED_AT }))
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan: planSeq1, generatedAt: GENERATED_AT }))

    const result = await listSupersededSegmentsFromManifests(bundleRoot)
    expect(result).toHaveLength(4)
    // Sort: (compaction_seq, entity_type, epoch, path)
    expect(result.map((r) => `${r.compaction_seq}/${r.entity_type}/${r.epoch}`)).toEqual([
      '1/sessions/1',
      '3/messages/5',
      '3/messages/6',
      '3/sessions/5',
    ])
  })

  it('silently skips compact-<NNNN>/ directories that lack a manifest', async () => {
    // Plant a manifest at seq 1 and an empty compact-0002 directory.
    const plan = planFor(1, [
      {
        entityType: 'sessions',
        reason: 'low_count_byte_ceiling',
        superseded: [{ epoch: 1, relative_segment: 'sessions.parquet', byteLength: 100 }],
      },
    ])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    await mkdir(join(bundleRoot, 'epochs', 'compact-0002'), { recursive: true })

    const result = await listSupersededSegmentsFromManifests(bundleRoot)
    expect(result.map((r) => r.compaction_seq)).toEqual([1])
  })

  it('symlinked `<bundleRoot>/epochs/compact-<NNNN>/` propagates the reader symlink throw', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-superseded-sym-'))
    try {
      await mkdir(join(bundleRoot, 'epochs'), { recursive: true })
      await symlink(external, join(bundleRoot, 'epochs', 'compact-0001'))
      await expect(listSupersededSegmentsFromManifests(bundleRoot)).rejects.toThrow(/symlink/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('propagates the deep-validation throw when a persisted manifest is malformed', async () => {
    const plan = planFor(1, [
      {
        entityType: 'sessions',
        reason: 'low_count_byte_ceiling',
        superseded: [{ epoch: 1, relative_segment: 'sessions.parquet', byteLength: 100 }],
      },
    ])
    const path = await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    // Corrupt the file: swap entity_type for a number.
    await writeFile(
      path,
      JSON.stringify({
        schema: 'prosa.compact-manifest.v2',
        compaction_seq: 1,
        generated_at: GENERATED_AT,
        entities: [{ entity_type: 42 }],
      }),
    )
    await expect(listSupersededSegmentsFromManifests(bundleRoot)).rejects.toThrow(/entity_type/)
  })
})

describe('summariseSupersededSegments', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-superseded-roll-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns zero rollup for a fresh bundle', async () => {
    expect(await summariseSupersededSegments(bundleRoot)).toEqual({
      total_segments: 0,
      total_bytes: 0,
      by_entity: {},
      by_compaction_seq: {},
    })
  })

  it('rolls up totals per-entity and per-compaction-seq across multiple manifests', async () => {
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({
        plan: planFor(1, [
          {
            entityType: 'sessions',
            reason: 'low_count_byte_ceiling',
            superseded: [
              { epoch: 1, relative_segment: 'sessions.parquet', byteLength: 100 },
              { epoch: 2, relative_segment: 'sessions.parquet', byteLength: 200 },
            ],
          },
        ]),
        generatedAt: GENERATED_AT,
      }),
    )
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({
        plan: planFor(3, [
          {
            entityType: 'messages',
            reason: 'file_count_trigger',
            superseded: [{ epoch: 5, relative_segment: 'messages.parquet', byteLength: 400 }],
          },
        ]),
        generatedAt: GENERATED_AT,
      }),
    )

    const rollup = await summariseSupersededSegments(bundleRoot)
    expect(rollup.total_segments).toBe(3)
    expect(rollup.total_bytes).toBe(700)
    expect(rollup.by_entity).toEqual({
      sessions: { count: 2, bytes: 300 },
      messages: { count: 1, bytes: 400 },
    })
    expect(rollup.by_compaction_seq).toEqual({
      '1': { count: 2, bytes: 300 },
      '3': { count: 1, bytes: 400 },
    })
  })
})
