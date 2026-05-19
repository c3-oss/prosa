// Compaction read-side end-to-end integration test.
//
// Each compaction surface has its own unit tests; this test wires
// them all together against one realistic multi-epoch Parquet
// segment fixture and asserts the data flows through correctly.
// Catches drift between the listing, summary, planner, and
// executor-plan composer without re-testing each unit.
//
// Pipeline exercised:
//
//   1. Plant Parquet projection segments across multiple epochs.
//   2. `listProjectionSegments(bundleRoot)` — enumerate every
//      `.parquet` segment as a flat `ProjectionSegment[]`.
//   3. `summariseProjectionSegments(bundleRoot)` — roll the flat
//      list into total / per-entity / per-epoch stats.
//   4. `planCompaction(bundleRoot)` — apply the compaction-policy
//      decision over the same segments and emit a deterministic
//      `CompactionPlan`.
//   5. `planCompactionExecution({ bundleRoot, plan })` — turn the
//      plan into the ordered DuckDB COPY statement sequence the
//      future runtime worker will execute.
//
// Asserts:
//
//   - Every segment the listing reports is also reachable by the
//     planner: when the policy fires for an entity, the plan's
//     input segments are a subset of the listing's per-entity
//     bytes.
//   - The summary's per-entity byte total ≥ the planner's
//     `totalBytesIn` for every fired entity.
//   - The executor-plan composer emits one COPY statement per
//     fired plan entity in plan order, each referencing the same
//     segments the planner picked.
//   - A fresh bundle (no `epochs/`) yields empty results across
//     every surface — no implicit "this looks like it should fire"
//     behaviour.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { planCompactionExecution } from '../../src/compaction/executor-plan.js'
import { planCompaction } from '../../src/compaction/planner.js'
import { listProjectionSegments, summariseProjectionSegments } from '../../src/compaction/segments.js'

async function plantSegment(bundleRoot: string, epoch: number, entityType: string, bytes: number) {
  const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${entityType}.parquet`), Buffer.alloc(bytes, 0xab))
}

describe('Compaction read-side end-to-end pipeline', () => {
  let bundleRoot: string

  beforeAll(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-int-compact-'))
    // Plant a fixture that should fire the `file_count_trigger`
    // for one entity (>32 small segments) and leave another entity
    // under threshold. Use the smallest possible payload (1 byte)
    // so the test is fast and the bytes math stays trivial.
    for (let epoch = 0; epoch < 33; epoch++) {
      await plantSegment(bundleRoot, epoch, 'sessions', 1024)
    }
    // Single segment for messages — should NOT fire compaction.
    await plantSegment(bundleRoot, 0, 'messages', 1024)
  })

  afterAll(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('listing returns every planted segment with the expected counts', async () => {
    const segments = await listProjectionSegments(bundleRoot)
    expect(segments).toHaveLength(34) // 33 sessions + 1 messages
    const sessions = segments.filter((s) => s.entityType === 'sessions')
    const messages = segments.filter((s) => s.entityType === 'messages')
    expect(sessions).toHaveLength(33)
    expect(messages).toHaveLength(1)
  })

  it('summary rolls up totals matching the listing', async () => {
    const segments = await listProjectionSegments(bundleRoot)
    const summary = await summariseProjectionSegments(bundleRoot)

    expect(summary.total_segments).toBe(segments.length)
    expect(summary.total_bytes).toBe(segments.reduce((acc, s) => acc + s.byteLength, 0))
    expect(summary.by_entity.sessions?.count).toBe(33)
    expect(summary.by_entity.messages?.count).toBe(1)
  })

  it('planner fires for the entity that crosses the file-count threshold', async () => {
    const plan = await planCompaction(bundleRoot)
    expect(plan.empty).toBe(false)
    expect(plan.entities.map((e) => e.entityType)).toEqual(['sessions'])
    const sessionsPlan = plan.entities[0]!
    expect(sessionsPlan.reason).toBe('file_count_trigger')
    // Every segment that goes into the merge must appear in the
    // overall listing.
    const allSegments = await listProjectionSegments(bundleRoot)
    const sessionsListed = new Set(allSegments.filter((s) => s.entityType === 'sessions').map((s) => s.path))
    for (const seg of sessionsPlan.segmentsToMerge) {
      expect(sessionsListed.has(seg.path)).toBe(true)
    }
  })

  it('summary per-entity bytes ≥ planner totalBytesIn (planner only merges small files)', async () => {
    const summary = await summariseProjectionSegments(bundleRoot)
    const plan = await planCompaction(bundleRoot)
    for (const entity of plan.entities) {
      const entityRollup = summary.by_entity[entity.entityType]
      expect(entityRollup).toBeDefined()
      expect(entity.totalBytesIn).toBeLessThanOrEqual(entityRollup!.bytes)
    }
  })

  it('executor-plan composer emits one COPY per fired entity, in plan order', async () => {
    const plan = await planCompaction(bundleRoot)
    const executionPlan = planCompactionExecution({ bundleRoot, plan })

    expect(executionPlan.statements).toHaveLength(plan.entities.length)
    for (let i = 0; i < plan.entities.length; i++) {
      const statement = executionPlan.statements[i]!
      const entity = plan.entities[i]!
      expect(statement.entityType).toBe(entity.entityType)
      // The COPY SQL must reference the bundle root + every input
      // segment's absolute path.
      expect(statement.sql).toContain('COPY')
      expect(statement.sql).toContain('read_parquet')
      for (const seg of entity.segmentsToMerge) {
        expect(statement.sql).toContain(join(bundleRoot, seg.path))
      }
    }
  })

  it('every executor-plan statement matches its corresponding plan entity 1:1', async () => {
    const plan = await planCompaction(bundleRoot)
    const executionPlan = planCompactionExecution({ bundleRoot, plan })
    for (const statement of executionPlan.statements) {
      const entity = plan.entities.find((e) => e.entityType === statement.entityType)
      expect(entity).toBeDefined()
      expect(statement.outputAbsPath).toContain(entity!.outputPath)
    }
  })
})

describe('Compaction read-side pipeline on a fresh bundle', () => {
  let bundleRoot: string

  beforeAll(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-int-compact-empty-'))
  })

  afterAll(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('listing, summary, and planner all collapse to empty on a fresh bundle', async () => {
    const segments = await listProjectionSegments(bundleRoot)
    const summary = await summariseProjectionSegments(bundleRoot)
    const plan = await planCompaction(bundleRoot)

    expect(segments).toEqual([])
    expect(summary.total_segments).toBe(0)
    expect(summary.total_bytes).toBe(0)
    expect(plan.entities).toEqual([])
    expect(plan.empty).toBe(true)
  })

  it('executor-plan composer emits zero statements for an empty plan', async () => {
    const plan = await planCompaction(bundleRoot)
    const executionPlan = planCompactionExecution({ bundleRoot, plan })
    expect(executionPlan.statements).toEqual([])
  })
})
