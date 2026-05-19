// Compaction execution-plan composition tests.
//
// `planCompactionExecution` is a pure data-shape composer: given the
// output of `planCompaction()` plus the bundle root, it returns the
// ordered DuckDB COPY statements the runtime worker will execute. The
// tests exercise the composition contract — they do not execute any
// SQL and they do not write any Parquet files.

import { describe, expect, it } from 'vitest'

import { planCompactionExecution } from '../../src/compaction/executor-plan.js'
import type { CompactionPlan } from '../../src/compaction/planner.js'

const BUNDLE = '/tmp/bundle'

function makePlan(): CompactionPlan {
  return {
    empty: false,
    entities: [
      {
        entityType: 'sessions',
        reason: 'file_count_trigger',
        outputPath: 'epochs/compact-0001/projection/sessions.compacted.parquet',
        totalBytesIn: 4096,
        segmentsToMerge: [
          { path: 'epochs/1/projection/sessions.parquet', byteLength: 1024, epoch: 1 },
          { path: 'epochs/2/projection/sessions.parquet', byteLength: 1024, epoch: 2 },
          { path: 'epochs/3/projection/sessions.parquet', byteLength: 2048, epoch: 3 },
        ],
      },
      {
        entityType: 'messages',
        reason: 'low_count_byte_ceiling',
        outputPath: 'epochs/compact-0001/projection/messages.compacted.parquet',
        totalBytesIn: 8192,
        segmentsToMerge: [
          { path: 'epochs/1/projection/messages.parquet', byteLength: 4096, epoch: 1 },
          { path: 'epochs/2/projection/messages.parquet', byteLength: 4096, epoch: 2 },
        ],
      },
    ],
  }
}

describe('planCompactionExecution', () => {
  it('returns empty `statements` when the source plan is empty', () => {
    const out = planCompactionExecution({
      bundleRoot: BUNDLE,
      plan: { entities: [], empty: true },
    })
    expect(out.statements).toEqual([])
    expect(out.plan.empty).toBe(true)
  })

  it('emits one COPY statement per entity, in the same order as the plan', () => {
    const plan = makePlan()
    const out = planCompactionExecution({ bundleRoot: BUNDLE, plan })
    expect(out.statements).toHaveLength(2)
    expect(out.statements[0]!.entityType).toBe('sessions')
    expect(out.statements[1]!.entityType).toBe('messages')
    for (const stmt of out.statements) {
      expect(stmt.sql.startsWith('COPY ')).toBe(true)
      expect(stmt.sql.endsWith(';')).toBe(true)
    }
  })

  it('binds every input segment as an absolute path inside the `read_parquet([...])` array', () => {
    const plan = makePlan()
    const out = planCompactionExecution({ bundleRoot: BUNDLE, plan })
    const sessionsSql = out.statements[0]!.sql
    expect(sessionsSql).toContain("'/tmp/bundle/epochs/1/projection/sessions.parquet'")
    expect(sessionsSql).toContain("'/tmp/bundle/epochs/2/projection/sessions.parquet'")
    expect(sessionsSql).toContain("'/tmp/bundle/epochs/3/projection/sessions.parquet'")
    expect(sessionsSql).toContain('union_by_name => true')
  })

  it('targets the absolute compacted output path with zstd-encoded Parquet', () => {
    const plan = makePlan()
    const out = planCompactionExecution({ bundleRoot: BUNDLE, plan })
    const sessions = out.statements[0]!
    expect(sessions.outputAbsPath).toBe('/tmp/bundle/epochs/compact-0001/projection/sessions.compacted.parquet')
    expect(sessions.outputDir).toBe('/tmp/bundle/epochs/compact-0001/projection')
    expect(sessions.sql).toContain(
      "TO '/tmp/bundle/epochs/compact-0001/projection/sessions.compacted.parquet' (FORMAT 'parquet', CODEC 'zstd')",
    )
  })

  it('escapes single quotes in the bundle root path so the generated SQL stays well-formed', () => {
    const plan = makePlan()
    const out = planCompactionExecution({ bundleRoot: "/tmp/o'malley", plan })
    for (const stmt of out.statements) {
      expect(stmt.sql).toContain("o''malley")
      // No raw apostrophe should appear adjacent to a non-quote
      // character inside the SQL string literals.
      expect(stmt.sql).not.toMatch(/o'malley[^']/)
    }
  })

  it('is deterministic — repeated calls with the same input produce identical SQL', () => {
    const plan = makePlan()
    const a = planCompactionExecution({ bundleRoot: BUNDLE, plan })
    const b = planCompactionExecution({ bundleRoot: BUNDLE, plan })
    expect(a.statements.map((s) => s.sql)).toEqual(b.statements.map((s) => s.sql))
  })

  it('preserves segment order from the source plan (oldest epoch first)', () => {
    // The planner sorts `segmentsToMerge` by epoch ascending; the
    // composer must keep that order so the merged output is
    // deterministic when callers rely on read-order semantics.
    const plan: CompactionPlan = {
      empty: false,
      entities: [
        {
          entityType: 'turns',
          reason: 'file_count_trigger',
          outputPath: 'epochs/compact-0001/projection/turns.compacted.parquet',
          totalBytesIn: 6,
          segmentsToMerge: [
            { path: 'epochs/1/projection/turns.parquet', byteLength: 1, epoch: 1 },
            { path: 'epochs/2/projection/turns.parquet', byteLength: 2, epoch: 2 },
            { path: 'epochs/3/projection/turns.parquet', byteLength: 3, epoch: 3 },
          ],
        },
      ],
    }
    const sql = planCompactionExecution({ bundleRoot: BUNDLE, plan }).statements[0]!.sql
    const idx1 = sql.indexOf('epochs/1/projection/turns.parquet')
    const idx2 = sql.indexOf('epochs/2/projection/turns.parquet')
    const idx3 = sql.indexOf('epochs/3/projection/turns.parquet')
    expect(idx1).toBeGreaterThan(-1)
    expect(idx2).toBeGreaterThan(idx1)
    expect(idx3).toBeGreaterThan(idx2)
  })

  it('exposes the source plan unchanged on the result', () => {
    const plan = makePlan()
    const out = planCompactionExecution({ bundleRoot: BUNDLE, plan })
    expect(out.plan).toBe(plan)
  })
})
