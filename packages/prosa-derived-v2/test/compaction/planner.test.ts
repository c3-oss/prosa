// Parquet compaction planner tests.
//
// Plans are content-free: the planner walks `epochs/<n>/projection/*.parquet`,
// stats each file, and applies the compaction trigger policy. These
// tests build fake on-disk layouts (zero-byte and small placeholder
// parquet files) and assert the resulting plan names exactly the
// segments the policy says should be merged.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planCompactionExecution } from '../../src/compaction/executor-plan.js'
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

  describe('CQ-101: containment hardening inherited from listProjectionSegments', () => {
    it('throws when `<bundleRoot>/epochs` is a symlink to an external tree', async () => {
      const root = await tmp()
      const external = await mkdtemp(join(tmpdir(), 'prosa-compaction-planner-cq101-ext-'))
      try {
        const extEpoch = join(external, '1', 'projection')
        await mkdir(extEpoch, { recursive: true })
        await writeFile(join(extEpoch, 'sessions.parquet'), Buffer.alloc(100))
        await symlink(external, join(root, 'epochs'))

        await expect(planCompaction(root)).rejects.toThrow(/symlink|epochs/i)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('silently drops a symlinked `<bundleRoot>/epochs/<n>` directory from the plan', async () => {
      const root = await tmp()
      // Plant 16 real small segments — exactly at the low-count
      // trigger boundary (the trigger fires only when count > 16
      // *and* total bytes < 256 MiB). With exactly 16 segments,
      // no trigger fires. A symlinked epoch contributing 5 more
      // would push count to 21 and fire `low_count_byte_ceiling`
      // if the planner followed the symlink.
      for (let epoch = 1; epoch <= 16; epoch++) {
        await writeSegment(root, epoch, 'sessions', 100)
      }
      const external = await mkdtemp(join(tmpdir(), 'prosa-compaction-planner-cq101-epoch-'))
      try {
        const extProj = join(external, 'projection')
        await mkdir(extProj, { recursive: true })
        for (let i = 0; i < 5; i++) {
          await writeFile(join(extProj, `session_${i}.parquet`), Buffer.alloc(100))
        }
        await symlink(external, join(root, 'epochs', '17'))

        const plan = await planCompaction(root)
        // The symlinked epoch is silently dropped — only the 16
        // real segments are counted, which is exactly at (not >)
        // the low-count trigger, so the plan stays empty.
        expect(plan.empty).toBe(true)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('CQ-102: silently drops a symlinked `epochs/<n>/projection/` directory from the plan', async () => {
      const root = await tmp()
      // 16 real segments at the low-count trigger boundary.
      for (let epoch = 1; epoch <= 16; epoch++) {
        await writeSegment(root, epoch, 'sessions', 100)
      }
      // Epoch 17 has a real epoch dir but its `projection/` is a
      // symlink to an external location with 5 segments — following
      // it would push count to 21 and fire the low-count trigger.
      await mkdir(join(root, 'epochs', '17'), { recursive: true })
      const external = await mkdtemp(join(tmpdir(), 'prosa-compaction-planner-cq102-proj-'))
      try {
        for (let i = 0; i < 5; i++) {
          await writeFile(join(external, `session_${i}.parquet`), Buffer.alloc(100))
        }
        await symlink(external, join(root, 'epochs', '17', 'projection'))

        const plan = await planCompaction(root)
        expect(plan.empty).toBe(true)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('CQ-102: planner-to-execution: planCompactionExecution never receives external symlink targets', async () => {
      const root = await tmp()
      // Plant enough small segments to fire the low-count trigger
      // (17 > 16) so the planner emits at least one entity entry,
      // and we can verify the execution plan it produces refers only
      // to real bundle paths.
      for (let epoch = 1; epoch <= 17; epoch++) {
        await writeSegment(root, epoch, 'sessions', 100)
      }
      // Plant a symlinked epoch dir + symlinked projection dir +
      // symlinked `.parquet` — every level should be dropped before
      // the planner's segment list reaches `planCompactionExecution`.
      const external = await mkdtemp(join(tmpdir(), 'prosa-compaction-planner-cq102-exec-'))
      try {
        // Symlinked epoch
        const externalEpochProj = join(external, 'sym-epoch', 'projection')
        await mkdir(externalEpochProj, { recursive: true })
        await writeFile(join(externalEpochProj, 'sessions.parquet'), Buffer.alloc(100))
        await symlink(join(external, 'sym-epoch'), join(root, 'epochs', '99'))

        // Symlinked projection on a real epoch
        await mkdir(join(root, 'epochs', '100'), { recursive: true })
        const externalProj = join(external, 'sym-proj')
        await mkdir(externalProj, { recursive: true })
        await writeFile(join(externalProj, 'sessions.parquet'), Buffer.alloc(100))
        await symlink(externalProj, join(root, 'epochs', '100', 'projection'))

        // Symlinked .parquet on a real epoch+projection
        await mkdir(join(root, 'epochs', '101', 'projection'), { recursive: true })
        await writeFile(join(external, 'external-file.parquet'), Buffer.alloc(100))
        await symlink(
          join(external, 'external-file.parquet'),
          join(root, 'epochs', '101', 'projection', 'sessions.parquet'),
        )

        const plan = await planCompaction(root)
        const execution = planCompactionExecution({ bundleRoot: root, plan })

        // The execution plan must reference ONLY paths inside the
        // canonical bundle root — no external symlink targets.
        const allExternalPaths = [
          external,
          join(external, 'sym-epoch'),
          join(external, 'sym-proj'),
          join(external, 'external-file.parquet'),
        ]
        for (const statement of execution.statements) {
          for (const externalPath of allExternalPaths) {
            expect(statement.sql).not.toContain(externalPath)
          }
          // Output path must be inside the bundle.
          expect(statement.outputAbsPath.startsWith(root)).toBe(true)
        }
        // Every input segment path the planner picked must be
        // inside the bundle. Belt-and-suspenders: re-verify against
        // the plan itself in case `planCompactionExecution` doesn't
        // include the absolute input path in the SQL string.
        for (const entity of plan.entities) {
          for (const seg of entity.segmentsToMerge) {
            // Relative paths in the plan; resolved against the
            // bundle root, they must stay inside the bundle.
            const resolved = join(root, seg.path)
            expect(resolved.startsWith(root)).toBe(true)
            for (const externalPath of allExternalPaths) {
              expect(resolved.startsWith(externalPath)).toBe(false)
            }
          }
        }
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('silently drops a symlinked `.parquet` file from the planner inputs', async () => {
      const root = await tmp()
      // Plant 16 real segments at the trigger boundary.
      for (let epoch = 1; epoch <= 16; epoch++) {
        await writeSegment(root, epoch, 'sessions', 100)
      }
      // Plant a symlinked .parquet that would push count to 17
      // (over the low-count trigger) if followed.
      const external = await mkdtemp(join(tmpdir(), 'prosa-compaction-planner-cq101-file-'))
      try {
        await writeFile(join(external, 'external.parquet'), Buffer.alloc(100))
        const dir = join(root, 'epochs', '17', 'projection')
        await mkdir(dir, { recursive: true })
        await symlink(join(external, 'external.parquet'), join(dir, 'sessions.parquet'))

        const plan = await planCompaction(root)
        // Symlinked file dropped — count stays at 16 (== threshold,
        // not >), so no trigger fires.
        expect(plan.empty).toBe(true)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })
  })
})
