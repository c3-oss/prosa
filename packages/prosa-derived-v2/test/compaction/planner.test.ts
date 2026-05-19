// Parquet compaction planner tests.
//
// Plans are content-free: the planner walks `epochs/<n>/projection/*.parquet`,
// stats each file, and applies the compaction trigger policy. These
// tests build fake on-disk layouts (zero-byte and small placeholder
// parquet files) and assert the resulting plan names exactly the
// segments the policy says should be merged.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planCompaction } from '../../src/compaction/planner.js'
import { COMPACTION_FILE_COUNT_TRIGGER } from '../../src/compaction/policy.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-compaction-planner-'))
}

async function writeSegment(bundleRoot: string, epoch: number, entityType: string, bytes: number): Promise<void> {
  const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
  await mkdir(dir, { recursive: true })
  // The planner does not parse Parquet — it only stats the file.
  await writeFile(join(dir, `${entityType}.parquet`), Buffer.alloc(bytes))
}

describe('planCompaction', () => {
  it('returns an empty plan when the bundle has no epochs directory at all', async () => {
    const root = await tmp()
    const plan = await planCompaction(root)
    expect(plan.empty).toBe(true)
    expect(plan.entities).toEqual([])
  })

  it('returns an empty plan when no entity has enough small segments to fire', async () => {
    const root = await tmp()
    // Five small segments across five epochs for the same entity is well under the trigger.
    for (let epoch = 1; epoch <= 5; epoch++) {
      await writeSegment(root, epoch, 'sessions', 4 * 1024 * 1024)
    }
    const plan = await planCompaction(root, { nextCompactionSeq: async () => 1 })
    expect(plan.empty).toBe(true)
  })

  it('fires on the file-count trigger when an entity has > 32 small segments', async () => {
    const root = await tmp()
    const count = COMPACTION_FILE_COUNT_TRIGGER + 1
    for (let epoch = 1; epoch <= count; epoch++) {
      await writeSegment(root, epoch, 'messages', 4 * 1024 * 1024)
    }
    const plan = await planCompaction(root, { nextCompactionSeq: async () => 7 })
    expect(plan.empty).toBe(false)
    expect(plan.entities).toHaveLength(1)
    const entityPlan = plan.entities[0]!
    expect(entityPlan.entityType).toBe('messages')
    expect(entityPlan.reason).toBe('file_count_trigger')
    expect(entityPlan.segmentsToMerge).toHaveLength(count)
    expect(entityPlan.outputPath).toBe(`epochs${sep}compact-0007${sep}projection${sep}messages.compacted.parquet`)
    expect(entityPlan.totalBytesIn).toBe(count * 4 * 1024 * 1024)
    // Segments are ordered by ascending epoch so the merge is deterministic.
    for (let i = 0; i < entityPlan.segmentsToMerge.length - 1; i++) {
      expect(entityPlan.segmentsToMerge[i]!.epoch).toBeLessThan(entityPlan.segmentsToMerge[i + 1]!.epoch)
    }
  })

  it('skips already-compacted directories so a planner re-run does not re-compact compacted output', async () => {
    const root = await tmp()
    // Create a `compact-0001/projection/messages.compacted.parquet` that
    // should be IGNORED by the planner; below-trigger live segments
    // should not produce a plan.
    const compactDir = join(root, 'epochs', 'compact-0001', 'projection')
    await mkdir(compactDir, { recursive: true })
    await writeFile(join(compactDir, 'messages.compacted.parquet'), Buffer.alloc(128 * 1024 * 1024))
    // Five live segments under the trigger.
    for (let epoch = 1; epoch <= 5; epoch++) {
      await writeSegment(root, epoch, 'messages', 4 * 1024 * 1024)
    }
    const plan = await planCompaction(root)
    expect(plan.empty).toBe(true)
  })

  it('groups segments by entity type and emits one plan entry per fired entity', async () => {
    const root = await tmp()
    const count = COMPACTION_FILE_COUNT_TRIGGER + 1
    for (let epoch = 1; epoch <= count; epoch++) {
      await writeSegment(root, epoch, 'messages', 4 * 1024 * 1024)
      await writeSegment(root, epoch, 'tool_calls', 4 * 1024 * 1024)
      // Just a single sessions segment per epoch — well under trigger.
      if (epoch <= 5) await writeSegment(root, epoch, 'sessions', 4 * 1024 * 1024)
    }
    const plan = await planCompaction(root, { nextCompactionSeq: async () => 1 })
    const names = plan.entities.map((e) => e.entityType).sort()
    expect(names).toEqual(['messages', 'tool_calls'])
    // `sessions` did not meet the trigger.
    expect(plan.entities.find((e) => e.entityType === 'sessions')).toBeUndefined()
  })

  it('honors the low-count byte-ceiling trigger when 17–32 small files weigh under 256 MiB total', async () => {
    const root = await tmp()
    // 17 segments × 4 MiB = 68 MiB total — well under the 256 MiB ceiling.
    for (let epoch = 1; epoch <= 17; epoch++) {
      await writeSegment(root, epoch, 'events', 4 * 1024 * 1024)
    }
    const plan = await planCompaction(root, { nextCompactionSeq: async () => 1 })
    expect(plan.empty).toBe(false)
    const eventsPlan = plan.entities.find((e) => e.entityType === 'events')!
    expect(eventsPlan.reason).toBe('low_count_byte_ceiling')
    expect(eventsPlan.segmentsToMerge).toHaveLength(17)
  })

  it('discovers next compaction sequence number from existing compact-NNNN directories', async () => {
    const root = await tmp()
    const count = COMPACTION_FILE_COUNT_TRIGGER + 1
    // Already-existing compact-0005 directory: the next plan should use 0006.
    await mkdir(join(root, 'epochs', 'compact-0005', 'projection'), { recursive: true })
    for (let epoch = 1; epoch <= count; epoch++) {
      await writeSegment(root, epoch, 'messages', 4 * 1024 * 1024)
    }
    const plan = await planCompaction(root)
    expect(plan.entities).toHaveLength(1)
    expect(plan.entities[0]!.outputPath).toBe(
      `epochs${sep}compact-0006${sep}projection${sep}messages.compacted.parquet`,
    )
  })

  it('ignores non-numeric and unexpected entries inside epochs/', async () => {
    const root = await tmp()
    await mkdir(join(root, 'epochs', 'README'), { recursive: true })
    await writeFile(join(root, 'epochs', 'README', 'note.txt'), 'ignored')
    for (let epoch = 1; epoch <= 5; epoch++) {
      await writeSegment(root, epoch, 'messages', 4 * 1024 * 1024)
    }
    const plan = await planCompaction(root)
    expect(plan.empty).toBe(true)
  })
})
