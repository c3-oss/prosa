// Tests for `planSupersededCleanup`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { planSupersededCleanup } from '../../src/compaction/gc-plan.js'
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

describe('planSupersededCleanup', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-gc-plan-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns an empty plan for a fresh bundle', async () => {
    const plan = await planSupersededCleanup(bundleRoot)
    expect(plan).toEqual({
      candidates: [],
      safe_to_delete: { count: 0, bytes: 0 },
      blocked: { count: 0, bytes: 0 },
    })
  })

  it('marks every superseded segment as safe_to_delete when the compaction-seq is consistent', async () => {
    const segments = [
      { epoch: 1, byteLength: 100 },
      { epoch: 2, byteLength: 200 },
    ]
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: planFor(1, 'sessions', segments), generatedAt: GENERATED_AT }),
    )
    await plantCompactedFile(bundleRoot, 1, 'sessions', 1234)

    const plan = await planSupersededCleanup(bundleRoot)
    expect(plan.candidates).toHaveLength(2)
    expect(plan.candidates.every((c) => c.safe_to_delete)).toBe(true)
    expect(plan.candidates.every((c) => c.blocked_reason === null)).toBe(true)
    expect(plan.safe_to_delete).toEqual({ count: 2, bytes: 300 })
    expect(plan.blocked).toEqual({ count: 0, bytes: 0 })
  })

  it('marks every superseded segment as blocked when the compaction-seq is inconsistent', async () => {
    const segments = [
      { epoch: 1, byteLength: 100 },
      { epoch: 2, byteLength: 200 },
    ]
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: planFor(1, 'sessions', segments), generatedAt: GENERATED_AT }),
    )
    // No compacted output planted → consistent=false.

    const plan = await planSupersededCleanup(bundleRoot)
    expect(plan.candidates).toHaveLength(2)
    expect(plan.candidates.every((c) => !c.safe_to_delete)).toBe(true)
    expect(plan.candidates.every((c) => c.blocked_reason === 'output_missing')).toBe(true)
    expect(plan.safe_to_delete).toEqual({ count: 0, bytes: 0 })
    expect(plan.blocked).toEqual({ count: 2, bytes: 300 })
  })

  it('partitions safe vs blocked across multiple compaction sequences', async () => {
    // Seq 1: consistent (planted output) → 2 safe rows
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({
        plan: planFor(1, 'sessions', [
          { epoch: 1, byteLength: 100 },
          { epoch: 2, byteLength: 200 },
        ]),
        generatedAt: GENERATED_AT,
      }),
    )
    await plantCompactedFile(bundleRoot, 1, 'sessions', 1024)

    // Seq 2: inconsistent → 1 blocked row
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({
        plan: planFor(2, 'messages', [{ epoch: 5, byteLength: 400 }]),
        generatedAt: GENERATED_AT,
      }),
    )

    const plan = await planSupersededCleanup(bundleRoot)
    expect(plan.candidates).toHaveLength(3)
    expect(plan.safe_to_delete).toEqual({ count: 2, bytes: 300 })
    expect(plan.blocked).toEqual({ count: 1, bytes: 400 })

    // Per-row predicates align with the partition.
    const bySeq = new Map<number, boolean[]>()
    for (const candidate of plan.candidates) {
      const list = bySeq.get(candidate.compaction_seq) ?? []
      list.push(candidate.safe_to_delete)
      bySeq.set(candidate.compaction_seq, list)
    }
    expect(bySeq.get(1)).toEqual([true, true])
    expect(bySeq.get(2)).toEqual([false])
  })

  it('preserves the underlying segment metadata on every row (path/epoch/byte_length/entity_type)', async () => {
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({
        plan: planFor(3, 'tool_calls', [{ epoch: 7, byteLength: 9001 }]),
        generatedAt: GENERATED_AT,
      }),
    )
    await plantCompactedFile(bundleRoot, 3, 'tool_calls', 64)

    const plan = await planSupersededCleanup(bundleRoot)
    expect(plan.candidates).toHaveLength(1)
    const [candidate] = plan.candidates
    expect(candidate?.path).toBe(`epochs${sep}7${sep}projection${sep}tool_calls.parquet`)
    expect(candidate?.epoch).toBe(7)
    expect(candidate?.byte_length).toBe(9001)
    expect(candidate?.entity_type).toBe('tool_calls')
    expect(candidate?.compaction_seq).toBe(3)
    expect(candidate?.safe_to_delete).toBe(true)
  })
})
