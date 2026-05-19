// Tests for `planGcExecution`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { planGcExecution } from '../../src/compaction/gc-execution-plan.js'
import type { SupersededCleanupPlan } from '../../src/compaction/gc-plan.js'
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

describe('planGcExecution', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-gc-exec-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns `{ empty: true, total_bytes: 0, steps: [] }` for an empty input plan', async () => {
    const exec = await planGcExecution({
      candidates: [],
      safe_to_delete: { count: 0, bytes: 0 },
      blocked: { count: 0, bytes: 0 },
    })
    expect(exec).toEqual({ empty: true, total_bytes: 0, steps: [] })
  })

  it('drops blocked candidates and keeps only safe-to-delete steps', async () => {
    const input: SupersededCleanupPlan = {
      candidates: [
        {
          path: 'a',
          epoch: 1,
          byte_length: 100,
          entity_type: 'sessions',
          compaction_seq: 1,
          safe_to_delete: true,
          blocked_reason: null,
        },
        {
          path: 'b',
          epoch: 2,
          byte_length: 200,
          entity_type: 'sessions',
          compaction_seq: 2,
          safe_to_delete: false,
          blocked_reason: 'output_missing',
        },
        {
          path: 'c',
          epoch: 3,
          byte_length: 300,
          entity_type: 'sessions',
          compaction_seq: 1,
          safe_to_delete: true,
          blocked_reason: null,
        },
      ],
      safe_to_delete: { count: 2, bytes: 400 },
      blocked: { count: 1, bytes: 200 },
    }
    const exec = await planGcExecution(input)
    expect(exec.empty).toBe(false)
    expect(exec.total_bytes).toBe(400)
    expect(exec.steps.map((s) => s.path)).toEqual(['a', 'c'])
    expect(exec.steps[0]).toEqual({
      path: 'a',
      byte_length: 100,
      epoch: 1,
      entity_type: 'sessions',
      compaction_seq: 1,
    })
  })

  it('preserves the inherited (compaction_seq, entity_type, epoch, path) ordering from the source plan', async () => {
    // Construct an input plan whose candidate ordering already
    // matches the documented sort: compaction_seq ascending, then
    // entity_type, then epoch, then path. `planGcExecution`
    // is required to preserve that order verbatim — it does not
    // re-sort.
    const input: SupersededCleanupPlan = {
      candidates: [
        {
          path: 'epochs/1/projection/messages.parquet',
          epoch: 1,
          byte_length: 10,
          entity_type: 'messages',
          compaction_seq: 1,
          safe_to_delete: true,
          blocked_reason: null,
        },
        {
          path: 'epochs/1/projection/sessions.parquet',
          epoch: 1,
          byte_length: 20,
          entity_type: 'sessions',
          compaction_seq: 1,
          safe_to_delete: true,
          blocked_reason: null,
        },
        {
          path: 'epochs/2/projection/sessions.parquet',
          epoch: 2,
          byte_length: 30,
          entity_type: 'sessions',
          compaction_seq: 1,
          safe_to_delete: true,
          blocked_reason: null,
        },
        {
          path: 'epochs/3/projection/sessions.parquet',
          epoch: 3,
          byte_length: 40,
          entity_type: 'sessions',
          compaction_seq: 2,
          safe_to_delete: true,
          blocked_reason: null,
        },
      ],
      safe_to_delete: { count: 4, bytes: 100 },
      blocked: { count: 0, bytes: 0 },
    }
    const exec = await planGcExecution(input)
    expect(exec.steps.map((s) => `${s.compaction_seq}:${s.entity_type}:${s.epoch}`)).toEqual([
      '1:messages:1',
      '1:sessions:1',
      '1:sessions:2',
      '2:sessions:3',
    ])
  })

  it('accepts a bundle root and resolves through planSupersededCleanup (planted compacted output → safe)', async () => {
    const plan = planFor(1, 'sessions', [
      { epoch: 1, byteLength: 1024 },
      { epoch: 2, byteLength: 2048 },
    ])
    const manifest = buildCompactManifestV2({ plan, generatedAt: GENERATED_AT })
    await writeCompactManifestV2(bundleRoot, manifest)
    await plantCompactedFile(bundleRoot, 1, 'sessions', 4096)

    const exec = await planGcExecution(bundleRoot)
    expect(exec.empty).toBe(false)
    expect(exec.total_bytes).toBe(1024 + 2048)
    expect(exec.steps).toHaveLength(2)
    expect(exec.steps.every((s) => s.compaction_seq === 1)).toBe(true)
    expect(exec.steps.every((s) => s.entity_type === 'sessions')).toBe(true)
    expect(exec.steps.map((s) => s.epoch).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('accepts a bundle root and returns empty when the only persisted manifest is inconsistent (CQ-111 parallel safety)', async () => {
    const plan = planFor(1, 'sessions', [{ epoch: 1, byteLength: 1024 }])
    const manifest = buildCompactManifestV2({ plan, generatedAt: GENERATED_AT })
    await writeCompactManifestV2(bundleRoot, manifest)
    // No compacted file planted → manifest inconsistent → no safe candidates.

    const exec = await planGcExecution(bundleRoot)
    expect(exec.empty).toBe(true)
    expect(exec.total_bytes).toBe(0)
    expect(exec.steps).toEqual([])
  })

  it('returns `{ empty: true }` for a bundle with no persisted manifests', async () => {
    const exec = await planGcExecution(bundleRoot)
    expect(exec).toEqual({ empty: true, total_bytes: 0, steps: [] })
  })
})
