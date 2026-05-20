// Parquet compaction runtime worker.
//
// Closes the loop on Lane 3 compaction:
//
//   1. `planCompaction(bundleRoot)` decides which entities need to be
//      compacted from on-disk Parquet segments (`./planner.ts`).
//   2. `planCompactionExecution(...)` composes the ordered DuckDB
//      `COPY (SELECT * FROM read_parquet([...], union_by_name => true))
//      TO '<output>' (FORMAT 'parquet', CODEC 'zstd');` statements
//      (`./executor-plan.ts`).
//   3. This module opens a `@duckdb/node-api` connection, creates the
//      output directory for each entity, executes the COPY statement,
//      and reports per-entity stats: input file count + bytes, output
//      bytes, row count, output path.
//
// The worker is row-preserving by construction (`read_parquet(...) → COPY`)
// and never deletes the source live segments — superseded cleanup is a
// separate planner/runtime concern (`gc-plan.ts`, `superseded.ts`). The
// canonical Merkle leaves are over row content (CANONICAL.md rule 7),
// so the merged compacted file does not change `bundleRoot`.

import { mkdir, stat } from 'node:fs/promises'

import { type CompactionExecutionPlan, planCompactionExecution } from './executor-plan.js'
import { type CompactionPlan, planCompaction } from './planner.js'

export interface RunCompactionInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Caller-supplied plan; defaults to `planCompaction(bundleRoot)`.
   *  Tests / scripted gates can inject a pre-computed plan to keep
   *  the worker step deterministic, or to compact a curated subset
   *  of the planner's output. */
  plan?: CompactionPlan
  /** When `true`, the worker resolves the plan + execution-plan but
   *  does not open a DuckDB connection, write any files, or run any
   *  SQL. Useful for `prosa index-v2 compaction-plan --dry-run`-style
   *  CLI surfaces. Result rows still describe the planned work,
   *  with `outputByteLength = 0` and `rowCount = 0`. */
  dryRun?: boolean
}

export interface CompactionEntityResult {
  /** Canonical entity name (`sessions`, `messages`, …). */
  entityType: string
  /** Absolute path the COPY wrote to. */
  outputAbsPath: string
  /** Number of live source segments the worker merged. */
  inputSegmentCount: number
  /** Aggregate byte length of the source live segments. */
  inputByteLength: number
  /** Byte length of the compacted output file on disk. Zero when
   *  `dryRun === true` (the file was not written). */
  outputByteLength: number
  /** Total row count in the compacted output file. Zero when
   *  `dryRun === true`. */
  rowCount: number
}

export interface RunCompactionResult {
  /** The resolved plan (caller-supplied or freshly planned). */
  plan: CompactionPlan
  /** The execution plan composed from the resolved plan. */
  executionPlan: CompactionExecutionPlan
  /** Per-entity outcome rows. Length always matches
   *  `executionPlan.statements`. */
  results: CompactionEntityResult[]
  /** True iff `plan.empty === true` — nothing was scheduled. The
   *  caller can branch on this without re-reading the inner plan. */
  empty: boolean
  /** Mirrors `input.dryRun ?? false`. Surfaced so callers piping the
   *  JSON through `jq` see exactly which run mode produced the
   *  rows. */
  dryRun: boolean
}

/** Lazy native module reference. */
type DuckDbModule = typeof import('@duckdb/node-api')

async function loadDuckDb(): Promise<DuckDbModule> {
  return await import('@duckdb/node-api')
}

/**
 * Execute the compaction plan against the bundle's Parquet projection
 * segments. Per entity, the worker:
 *
 *   - creates the output directory recursively;
 *   - issues the composer-built `COPY ... TO ... (FORMAT 'parquet',
 *     CODEC 'zstd')` statement on the shared DuckDB connection;
 *   - reads the resulting file's byte length and queries the row
 *     count back through DuckDB for the result row.
 *
 * Returns an empty `results` list when the plan is empty (no entity
 * met the policy's fire thresholds). The DuckDB connection is closed
 * in a `finally` block so a crash in any step still releases it.
 *
 * Side effects are confined to `<bundleRoot>/epochs/compact-<NNNN>/`
 * subdirectories the planner names. The worker never modifies the
 * live `epochs/<n>/projection/` segments — superseded cleanup is a
 * separate planner/runtime concern.
 */
export async function runCompaction(input: RunCompactionInput): Promise<RunCompactionResult> {
  const plan = input.plan ?? (await planCompaction(input.bundleRoot))
  const executionPlan = planCompactionExecution({ bundleRoot: input.bundleRoot, plan })
  const dryRun = input.dryRun ?? false

  if (plan.empty || executionPlan.statements.length === 0) {
    return { plan, executionPlan, results: [], empty: true, dryRun }
  }

  const results: CompactionEntityResult[] = []

  if (dryRun) {
    for (let i = 0; i < executionPlan.statements.length; i++) {
      const stmt = executionPlan.statements[i]
      if (stmt === undefined) continue
      const entity = plan.entities[i]
      if (entity === undefined) continue
      results.push({
        entityType: stmt.entityType,
        outputAbsPath: stmt.outputAbsPath,
        inputSegmentCount: entity.segmentsToMerge.length,
        inputByteLength: entity.totalBytesIn,
        outputByteLength: 0,
        rowCount: 0,
      })
    }
    return { plan, executionPlan, results, empty: false, dryRun }
  }

  const duckdb = await loadDuckDb()
  const connection = await duckdb.DuckDBConnection.create()
  try {
    for (let i = 0; i < executionPlan.statements.length; i++) {
      const stmt = executionPlan.statements[i]
      if (stmt === undefined) continue
      const entity = plan.entities[i]
      if (entity === undefined) continue
      await mkdir(stmt.outputDir, { recursive: true })
      await connection.run(stmt.sql)
      const outputStat = await stat(stmt.outputAbsPath)
      const countReader = await connection.runAndReadAll(
        `SELECT count(*)::BIGINT AS n FROM read_parquet(${quoteSqlString(stmt.outputAbsPath)});`,
      )
      const countRow = countReader.getRowObjectsJson()[0] as { n: bigint | number | string } | undefined
      const rowCount = countRow === undefined ? 0 : Number(countRow.n)
      results.push({
        entityType: stmt.entityType,
        outputAbsPath: stmt.outputAbsPath,
        inputSegmentCount: entity.segmentsToMerge.length,
        inputByteLength: entity.totalBytesIn,
        outputByteLength: outputStat.size,
        rowCount,
      })
    }
  } finally {
    connection.closeSync()
  }

  return { plan, executionPlan, results, empty: false, dryRun }
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
