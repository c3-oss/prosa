// Tests for `listCompactionHistory`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listCompactionHistory } from '../../src/compaction/history.js'
import { buildCompactManifestV2, writeCompactManifestV2 } from '../../src/compaction/manifest.js'
import type { CompactionPlan } from '../../src/compaction/planner.js'

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

async function plantCompactedFile(bundleRoot: string, seq: number, entityType: string, bytes: number): Promise<void> {
  const dir = join(bundleRoot, 'epochs', `compact-${String(seq).padStart(4, '0')}`, 'projection')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${entityType}.compacted.parquet`), Buffer.alloc(bytes))
}

describe('listCompactionHistory', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-history-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns `[]` for a bundle with no persisted manifests', async () => {
    const history = await listCompactionHistory(bundleRoot)
    expect(history).toEqual([])
  })

  it('emits one row per persisted manifest with verbatim generated_at and the audit consistency flag', async () => {
    const generatedAt = '2026-05-19T12:00:00.000Z'
    const plan = planFor(1, 'sessions', [
      { epoch: 1, byteLength: 1024 },
      { epoch: 2, byteLength: 2048 },
    ])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt }))
    await plantCompactedFile(bundleRoot, 1, 'sessions', 1024)

    const history = await listCompactionHistory(bundleRoot)
    expect(history).toHaveLength(1)
    const row = history[0]!
    expect(row.compaction_seq).toBe(1)
    expect(row.generated_at).toBe(generatedAt)
    expect(row.consistent).toBe(true)
    expect(row.entity_count).toBe(1)
    expect(row.superseded_segment_count).toBe(2)
    expect(row.manifest_path).toMatch(/compact-0001[\\/]compact\.manifest\.json$/)
  })

  it('flags an inconsistent manifest while preserving its generated_at', async () => {
    const generatedAt = '2026-05-19T13:00:00.000Z'
    const plan = planFor(1, 'sessions', [{ epoch: 1, byteLength: 5000 }])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt }))
    // No compacted file planted.

    const history = await listCompactionHistory(bundleRoot)
    expect(history).toHaveLength(1)
    expect(history[0]!.consistent).toBe(false)
    expect(history[0]!.generated_at).toBe(generatedAt)
  })

  it('sorts by compaction_seq ascending across multiple persisted manifests', async () => {
    const plan2 = planFor(2, 'sessions', [{ epoch: 3, byteLength: 1024 }])
    const plan1 = planFor(1, 'sessions', [{ epoch: 1, byteLength: 1024 }])
    const plan3 = planFor(3, 'messages', [{ epoch: 5, byteLength: 1024 }])
    // Write deliberately out of seq order to ensure ordering comes
    // from the listing pass, not write order.
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: plan2, generatedAt: '2026-05-19T12:01:00.000Z' }),
    )
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: plan3, generatedAt: '2026-05-19T12:02:00.000Z' }),
    )
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: plan1, generatedAt: '2026-05-19T12:00:00.000Z' }),
    )

    const history = await listCompactionHistory(bundleRoot)
    expect(history.map((r) => r.compaction_seq)).toEqual([1, 2, 3])
    expect(history.map((r) => r.generated_at)).toEqual([
      '2026-05-19T12:00:00.000Z',
      '2026-05-19T12:01:00.000Z',
      '2026-05-19T12:02:00.000Z',
    ])
  })

  it('aggregates superseded_segment_count across a multi-entity manifest', async () => {
    const plan: CompactionPlan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'low_count_byte_ceiling',
          outputPath: `epochs${sep}compact-0001${sep}projection${sep}sessions.compacted.parquet`,
          totalBytesIn: 3072,
          segmentsToMerge: [
            { epoch: 1, path: `epochs${sep}1${sep}projection${sep}sessions.parquet`, byteLength: 1024 },
            { epoch: 2, path: `epochs${sep}2${sep}projection${sep}sessions.parquet`, byteLength: 2048 },
          ],
        },
        {
          entityType: 'messages',
          reason: 'low_count_byte_ceiling',
          outputPath: `epochs${sep}compact-0001${sep}projection${sep}messages.compacted.parquet`,
          totalBytesIn: 4096,
          segmentsToMerge: [
            { epoch: 1, path: `epochs${sep}1${sep}projection${sep}messages.parquet`, byteLength: 4096 },
          ],
        },
      ],
    }
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: '2026-05-19T12:00:00.000Z' }))
    await plantCompactedFile(bundleRoot, 1, 'sessions', 512)
    await plantCompactedFile(bundleRoot, 1, 'messages', 512)

    const history = await listCompactionHistory(bundleRoot)
    expect(history).toHaveLength(1)
    expect(history[0]!.entity_count).toBe(2)
    expect(history[0]!.superseded_segment_count).toBe(3)
    expect(history[0]!.consistent).toBe(true)
  })
})
