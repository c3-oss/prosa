// Compaction execution-plan composition.
//
// `planCompaction` (in `./planner.ts`) walks the bundle's Parquet
// projection segments and decides which entity types need to be
// compacted. This module turns that decision into the ordered DuckDB
// statement sequence the runtime worker will execute to materialise
// the compacted segments.
//
// No DuckDB connection is opened and no statements are executed; the
// result is a pure data structure callers (and tests) can inspect.
// The runtime worker consumes the list verbatim, applying `mkdir -p`
// on each output directory before executing the corresponding
// `COPY ... TO ...` statement.

import { dirname, join, sep } from 'node:path'

import type { CompactionPlan, PlannedSegmentRef } from './planner.js'

export interface CompactionStatement {
  /** Canonical entity name (e.g. `sessions`, `messages`). */
  entityType: string
  /** Absolute output path the COPY writes to. The runtime worker
   *  must ensure the parent directory exists before executing. */
  outputAbsPath: string
  /** Parent directory of `outputAbsPath`. Surfaced so the runtime
   *  worker can `mkdir -p` once per entity without re-deriving the
   *  parent from the SQL. */
  outputDir: string
  /** The complete, semicolon-terminated DuckDB COPY statement. */
  sql: string
}

export interface CompactionExecutionPlan {
  /** Source plan from `planCompaction()`. Surfaced so the runtime
   *  worker can also see segment sources and fire reasons without
   *  needing to call the planner again. */
  plan: CompactionPlan
  /** One COPY statement per entity in `plan.entities`, in the same
   *  order. Empty when `plan.empty === true`. */
  statements: CompactionStatement[]
}

export interface PlanCompactionExecutionInput {
  /** Absolute bundle root. Used to resolve relative segment paths
   *  and the relative output path in `plan.entities[i].outputPath`. */
  bundleRoot: string
  /** Plan returned by `planCompaction(bundleRoot)`. */
  plan: CompactionPlan
}

/**
 * Compose the ordered DuckDB statement sequence that materialises the
 * compacted Parquet segments described by `plan`. Each entity in the
 * plan yields a single `COPY (SELECT * FROM read_parquet([...],
 * union_by_name => true)) TO '<output>' (FORMAT 'parquet', CODEC
 * 'zstd');` statement.
 *
 * Returns an empty `statements` list when `plan.empty === true`. The
 * helper does not touch the filesystem and does not execute any SQL.
 */
export function planCompactionExecution(input: PlanCompactionExecutionInput): CompactionExecutionPlan {
  const statements: CompactionStatement[] = []
  for (const entity of input.plan.entities) {
    const segmentPaths = entity.segmentsToMerge.map((s) => absolutize(input.bundleRoot, s))
    const outputAbsPath = join(input.bundleRoot, entity.outputPath)
    const outputDir = dirname(outputAbsPath)
    const readArray = segmentPaths.map(quoteForSql).join(', ')
    const sql =
      `COPY (SELECT * FROM read_parquet([${readArray}], union_by_name => true)) ` +
      `TO ${quoteForSql(outputAbsPath)} (FORMAT 'parquet', CODEC 'zstd');`
    statements.push({
      entityType: entity.entityType,
      outputAbsPath,
      outputDir,
      sql,
    })
  }
  return { plan: input.plan, statements }
}

function absolutize(bundleRoot: string, segment: PlannedSegmentRef): string {
  // The planner stores segment paths relative to the bundle root
  // using the platform `sep`. `join` normalises any extra separators
  // and yields the absolute path the runtime executor needs.
  return join(bundleRoot, segment.path.split(sep).join(sep))
}

function quoteForSql(value: string): string {
  // Single-quote the value, doubling embedded single quotes per
  // standard SQL string-literal escaping. Defensive against
  // pathological bundle roots that happen to contain a quote.
  return `'${value.replace(/'/g, "''")}'`
}
