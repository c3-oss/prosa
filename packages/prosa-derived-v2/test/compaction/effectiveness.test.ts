// Tests for `summariseCompactionEffectiveness`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { summariseCompactionEffectiveness } from '../../src/compaction/effectiveness.js'
import { buildCompactManifestV2, writeCompactManifestV2 } from '../../src/compaction/manifest.js'
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

async function plantCompactedFile(bundleRoot: string, seq: number, entityType: string, bytes: number): Promise<void> {
  const dir = join(bundleRoot, 'epochs', `compact-${String(seq).padStart(4, '0')}`, 'projection')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${entityType}.compacted.parquet`), Buffer.alloc(bytes))
}

describe('summariseCompactionEffectiveness', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-effectiveness-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns the zero-state summary for a bundle with no persisted manifests', async () => {
    const summary = await summariseCompactionEffectiveness(bundleRoot)
    expect(summary.rows).toEqual([])
    expect(summary.totals).toEqual({
      consistent_count: 0,
      inconsistent_count: 0,
      bytes_in_consistent: 0,
      bytes_out: 0,
      bytes_saved: 0,
      reduction_ratio: 0,
    })
  })

  it('reports the effectiveness row + totals when a manifest lands cleanly', async () => {
    const plan = planFor(1, 'sessions', [
      { epoch: 1, byteLength: 1024 },
      { epoch: 2, byteLength: 2048 },
      { epoch: 3, byteLength: 4096 },
    ])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    await plantCompactedFile(bundleRoot, 1, 'sessions', 1024)

    const summary = await summariseCompactionEffectiveness(bundleRoot)
    expect(summary.rows).toHaveLength(1)
    const row = summary.rows[0]!
    expect(row.compaction_seq).toBe(1)
    expect(row.consistent).toBe(true)
    expect(row.bytes_in).toBe(7168)
    expect(row.bytes_out).toBe(1024)
    expect(row.bytes_saved).toBe(6144)
    expect(row.reduction_ratio).toBeCloseTo(6144 / 7168, 6)
    expect(row.superseded_segment_count).toBe(3)
    expect(row.output_count).toBe(1)
    expect(row.missing_output_count).toBe(0)
    expect(summary.totals).toEqual({
      consistent_count: 1,
      inconsistent_count: 0,
      bytes_in_consistent: 7168,
      bytes_out: 1024,
      bytes_saved: 6144,
      reduction_ratio: 6144 / 7168,
    })
  })

  it('reports the inconsistent row with bytes_out/saved/reduction_ratio === null and excludes it from totals', async () => {
    const plan = planFor(1, 'sessions', [{ epoch: 1, byteLength: 5000 }])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    // No compacted file planted → audit.consistent === false.

    const summary = await summariseCompactionEffectiveness(bundleRoot)
    expect(summary.rows).toHaveLength(1)
    const row = summary.rows[0]!
    expect(row.consistent).toBe(false)
    expect(row.bytes_in).toBe(5000)
    expect(row.bytes_out).toBeNull()
    expect(row.bytes_saved).toBeNull()
    expect(row.reduction_ratio).toBeNull()
    expect(row.missing_output_count).toBe(1)
    expect(summary.totals).toEqual({
      consistent_count: 0,
      inconsistent_count: 1,
      bytes_in_consistent: 0,
      bytes_out: 0,
      bytes_saved: 0,
      reduction_ratio: 0,
    })
  })

  it('mixes consistent + inconsistent rows: totals roll up only the consistent subset', async () => {
    const consistentPlan = planFor(1, 'sessions', [
      { epoch: 1, byteLength: 1024 },
      { epoch: 2, byteLength: 1024 },
    ])
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: consistentPlan, generatedAt: GENERATED_AT }),
    )
    await plantCompactedFile(bundleRoot, 1, 'sessions', 512)

    const inconsistentPlan = planFor(2, 'sessions', [{ epoch: 3, byteLength: 9999 }])
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: inconsistentPlan, generatedAt: GENERATED_AT }),
    )
    // Do NOT plant the compact-0002 output → row 2 is inconsistent.

    const summary = await summariseCompactionEffectiveness(bundleRoot)
    expect(summary.rows.map((r) => r.compaction_seq)).toEqual([1, 2])
    expect(summary.rows[0]!.consistent).toBe(true)
    expect(summary.rows[1]!.consistent).toBe(false)
    expect(summary.totals.consistent_count).toBe(1)
    expect(summary.totals.inconsistent_count).toBe(1)
    expect(summary.totals.bytes_in_consistent).toBe(2048)
    expect(summary.totals.bytes_out).toBe(512)
    expect(summary.totals.bytes_saved).toBe(1536)
    expect(summary.totals.reduction_ratio).toBeCloseTo(1536 / 2048, 6)
    // 9999 must NOT appear in bytes_in_consistent.
    expect(summary.totals.bytes_in_consistent).not.toBe(2048 + 9999)
  })

  it('handles degenerate bytes_in === 0 (consistent) by emitting reduction_ratio === 0 rather than dividing by zero', async () => {
    // Build a manifest whose superseded segments are size 0. (The
    // planner would not normally emit this — it requires existing
    // segments — but we exercise the math defensively.)
    const plan = planFor(1, 'sessions', [{ epoch: 1, byteLength: 0 }])
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    await plantCompactedFile(bundleRoot, 1, 'sessions', 0)

    const summary = await summariseCompactionEffectiveness(bundleRoot)
    expect(summary.rows).toHaveLength(1)
    expect(summary.rows[0]!.bytes_in).toBe(0)
    expect(summary.rows[0]!.bytes_out).toBe(0)
    expect(summary.rows[0]!.bytes_saved).toBe(0)
    expect(summary.rows[0]!.reduction_ratio).toBe(0)
    expect(summary.totals.reduction_ratio).toBe(0)
  })

  it('handles a multi-entity manifest: aggregates inputs across entities and outputs across files', async () => {
    // Build a 2-entity plan manually so we exercise the
    // multi-entity summing path.
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
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    await plantCompactedFile(bundleRoot, 1, 'sessions', 512)
    await plantCompactedFile(bundleRoot, 1, 'messages', 1024)

    const summary = await summariseCompactionEffectiveness(bundleRoot)
    expect(summary.rows).toHaveLength(1)
    const row = summary.rows[0]!
    expect(row.bytes_in).toBe(3072 + 4096)
    expect(row.bytes_out).toBe(512 + 1024)
    expect(row.superseded_segment_count).toBe(3)
    expect(row.output_count).toBe(2)
    expect(row.consistent).toBe(true)
  })
})
