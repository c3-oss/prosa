// runCompaction worker tests against real Parquet files.
//
// Plants a 33-small-segment scenario (one tiny `sessions.parquet`
// per epoch under `epochs/<n>/projection/`) that trips the policy's
// `file_count_trigger` (> 32 small segments). Asserts:
//
//   - the planner picks up exactly those segments;
//   - the worker writes a compacted file under
//     `epochs/compact-<NNNN>/projection/sessions.compacted.parquet`;
//   - the compacted row count equals the sum of the source row
//     counts (row-preserving merge);
//   - the source live segments are still on disk (the worker does
//     not delete them — superseded cleanup is a separate concern);
//   - the `dryRun` path returns the planned work without opening
//     a DuckDB connection or writing any files.
//
// Heap/threads stay at DuckDB's defaults; the parquets are tiny so
// the test runs in well under a second.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { runCompaction } from '../../src/compaction/runtime-worker.js'

type DuckDbModule = typeof import('@duckdb/node-api')
let duckdb: DuckDbModule

beforeAll(async () => {
  duckdb = await import('@duckdb/node-api')
})

/** Write a tiny `<entity>.parquet` for an epoch with `rowsPerSeg`
 *  one-column rows. Uses DuckDB's `COPY` so the schema matches what
 *  `read_parquet` will see. */
async function plantSegment(
  bundleRoot: string,
  epoch: number,
  entity: string,
  rowsPerSeg: number,
  startId: number,
): Promise<string> {
  const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${entity}.parquet`)
  const conn = await duckdb.DuckDBConnection.create()
  try {
    const valuesLines: string[] = []
    for (let i = 0; i < rowsPerSeg; i++) {
      valuesLines.push(`('ses_${startId + i}', 'codex')`)
    }
    await conn.run(
      `COPY (SELECT * FROM (VALUES ${valuesLines.join(', ')}) AS t(session_id, source_tool)) ` +
        `TO '${path.replace(/'/g, "''")}' (FORMAT PARQUET);`,
    )
  } finally {
    conn.closeSync()
  }
  return path
}

describe('runCompaction', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-compaction-runtime-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns empty when no entity meets the policy fire thresholds', async () => {
    // Plant 4 small segments — under the 16/32 file count triggers.
    for (let epoch = 0; epoch < 4; epoch++) {
      await plantSegment(bundleRoot, epoch, 'sessions', 1, epoch)
    }
    const result = await runCompaction({ bundleRoot })
    expect(result.empty).toBe(true)
    expect(result.plan.empty).toBe(true)
    expect(result.results).toEqual([])
    expect(result.executionPlan.statements).toEqual([])
  })

  it('compacts 33 small one-row sessions.parquet segments and preserves the total row count', async () => {
    // Plant 33 segments → triggers `file_count_trigger` (> 32).
    const sourcePaths: string[] = []
    for (let epoch = 0; epoch < 33; epoch++) {
      sourcePaths.push(await plantSegment(bundleRoot, epoch, 'sessions', 1, epoch))
    }

    const result = await runCompaction({ bundleRoot })
    expect(result.empty).toBe(false)
    expect(result.dryRun).toBe(false)
    expect(result.plan.entities).toHaveLength(1)
    const entity = result.plan.entities[0]
    if (entity === undefined) throw new Error('unreachable')
    expect(entity.entityType).toBe('sessions')
    expect(entity.reason).toBe('file_count_trigger')
    expect(entity.segmentsToMerge).toHaveLength(33)

    expect(result.results).toHaveLength(1)
    const entityResult = result.results[0]
    if (entityResult === undefined) throw new Error('unreachable')
    expect(entityResult.entityType).toBe('sessions')
    expect(entityResult.inputSegmentCount).toBe(33)
    expect(entityResult.rowCount).toBe(33)
    expect(entityResult.outputByteLength).toBeGreaterThan(0)
    expect(entityResult.outputAbsPath).toContain('compact-0001')
    expect(entityResult.outputAbsPath).toContain('sessions.compacted.parquet')

    // The compacted file exists; the source live segments still
    // exist (the worker is non-destructive).
    expect(existsSync(entityResult.outputAbsPath)).toBe(true)
    for (const sourcePath of sourcePaths) {
      expect(existsSync(sourcePath)).toBe(true)
    }

    // The compacted file is a real Parquet — DuckDB can read it back.
    const conn = await duckdb.DuckDBConnection.create()
    try {
      const escapedPath = entityResult.outputAbsPath.replace(/'/g, "''")
      const reader = await conn.runAndReadAll(
        `SELECT count(*)::BIGINT AS n, count(DISTINCT session_id)::BIGINT AS distinct_sessions FROM read_parquet('${escapedPath}');`,
      )
      const row = reader.getRowObjectsJson()[0] as {
        n: bigint | number | string
        distinct_sessions: bigint | number | string
      }
      expect(Number(row.n)).toBe(33)
      expect(Number(row.distinct_sessions)).toBe(33)
    } finally {
      conn.closeSync()
    }
  })

  it('dryRun returns the planned work without opening DuckDB or writing files', async () => {
    for (let epoch = 0; epoch < 33; epoch++) {
      await plantSegment(bundleRoot, epoch, 'sessions', 1, epoch)
    }
    const result = await runCompaction({ bundleRoot, dryRun: true })
    expect(result.empty).toBe(false)
    expect(result.dryRun).toBe(true)
    expect(result.results).toHaveLength(1)
    const entityResult = result.results[0]
    if (entityResult === undefined) throw new Error('unreachable')
    expect(entityResult.inputSegmentCount).toBe(33)
    expect(entityResult.outputByteLength).toBe(0)
    expect(entityResult.rowCount).toBe(0)
    // The output file must NOT exist after a dry run.
    expect(existsSync(entityResult.outputAbsPath)).toBe(false)
  })

  it('honours a caller-supplied plan', async () => {
    for (let epoch = 0; epoch < 33; epoch++) {
      await plantSegment(bundleRoot, epoch, 'sessions', 1, epoch)
    }
    // Build a plan that explicitly targets only the first 17
    // segments — the worker should merge exactly those 17, not all
    // 33 the auto-planner would otherwise pick.
    const { planCompaction } = await import('../../src/compaction/planner.js')
    const fullPlan = await planCompaction(bundleRoot)
    expect(fullPlan.entities).toHaveLength(1)
    const fullEntity = fullPlan.entities[0]
    if (fullEntity === undefined) throw new Error('unreachable')
    const trimmedPlan = {
      empty: false,
      entities: [
        {
          ...fullEntity,
          segmentsToMerge: fullEntity.segmentsToMerge.slice(0, 17),
          totalBytesIn: fullEntity.segmentsToMerge.slice(0, 17).reduce((sum, s) => sum + s.byteLength, 0),
        },
      ],
    }
    const result = await runCompaction({ bundleRoot, plan: trimmedPlan })
    expect(result.results).toHaveLength(1)
    const entityResult = result.results[0]
    if (entityResult === undefined) throw new Error('unreachable')
    expect(entityResult.inputSegmentCount).toBe(17)
    expect(entityResult.rowCount).toBe(17)
  })

  it('CQ-118: rejects a caller-supplied plan with an absolute segmentsToMerge[].path', async () => {
    const plan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'file_count_trigger' as const,
          segmentsToMerge: [{ path: '/etc/passwd', byteLength: 1, epoch: 0 }],
          outputPath: 'epochs/compact-0001/projection/sessions.compacted.parquet',
          totalBytesIn: 1,
        },
      ],
    }
    await expect(runCompaction({ bundleRoot, plan, dryRun: true })).rejects.toThrow(/is absolute/)
  })

  it('CQ-118: rejects a caller-supplied plan with `..` traversal in segmentsToMerge[].path', async () => {
    const plan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'file_count_trigger' as const,
          segmentsToMerge: [{ path: '../outside-input.parquet', byteLength: 1, epoch: 0 }],
          outputPath: 'epochs/compact-0001/projection/sessions.compacted.parquet',
          totalBytesIn: 1,
        },
      ],
    }
    await expect(runCompaction({ bundleRoot, plan, dryRun: true })).rejects.toThrow(/'\.\.'/)
  })

  it('CQ-118: rejects a caller-supplied plan with an absolute outputPath', async () => {
    const plan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'file_count_trigger' as const,
          segmentsToMerge: [{ path: 'epochs/0/projection/sessions.parquet', byteLength: 1, epoch: 0 }],
          outputPath: '/tmp/escape-output.parquet',
          totalBytesIn: 1,
        },
      ],
    }
    await expect(runCompaction({ bundleRoot, plan, dryRun: true })).rejects.toThrow(/is absolute/)
  })

  it('CQ-118: rejects a caller-supplied plan with `..` traversal in outputPath', async () => {
    const plan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'file_count_trigger' as const,
          segmentsToMerge: [{ path: 'epochs/0/projection/sessions.parquet', byteLength: 1, epoch: 0 }],
          outputPath: '../outside-output.parquet',
          totalBytesIn: 1,
        },
      ],
    }
    await expect(runCompaction({ bundleRoot, plan, dryRun: true })).rejects.toThrow(/'\.\.'/)
  })

  it('CQ-118: containment check runs before any FS / DuckDB side effect (dry-run path)', async () => {
    // No live parquets planted; the path still triggers the check
    // because the worker validates before composing or running.
    const plan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'file_count_trigger' as const,
          segmentsToMerge: [{ path: '/abs/escape.parquet', byteLength: 1, epoch: 0 }],
          outputPath: '../escape.parquet',
          totalBytesIn: 1,
        },
      ],
    }
    await expect(runCompaction({ bundleRoot, plan })).rejects.toThrow(/is absolute|'\.\.'/)
  })

  it('reports outputByteLength from the on-disk compacted file', async () => {
    for (let epoch = 0; epoch < 33; epoch++) {
      await plantSegment(bundleRoot, epoch, 'sessions', 1, epoch)
    }
    const result = await runCompaction({ bundleRoot })
    const entityResult = result.results[0]
    if (entityResult === undefined) throw new Error('unreachable')
    const st = await stat(entityResult.outputAbsPath)
    expect(entityResult.outputByteLength).toBe(st.size)
  })
})
