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
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'

import { type CompactionExecutionPlan, planCompactionExecution } from './executor-plan.js'
import { buildCompactManifestV2, writeCompactManifestV2 } from './manifest.js'
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
  /** ISO-8601 timestamp embedded as `generated_at` on the persisted
   *  compact manifest. Defaults to `new Date().toISOString()`.
   *  Exposed so tests can pin a deterministic timestamp. */
  generatedAt?: string
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
  /** Absolute path to the persisted compact manifest, or `null` when
   *  the worker did not write one (empty plan or `dryRun === true`).
   *  CQ-117: consumers (the analytics runtime, audit/GC helpers) use
   *  the manifest to discover which live segments are superseded by
   *  the compacted output so they can be filtered out of read
   *  globs. */
  manifestPath: string | null
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
  // CQ-118: validate caller-supplied plans before composing the
  // execution plan or running any DuckDB / file side effect. A
  // freshly-built `planCompaction` plan is always contained, so a
  // re-validation here is a defensive belt-and-braces; the cost is
  // a few path joins per entity. Validation runs before `dryRun`
  // returns so even dry-run callers cannot inspect an escaping
  // execution plan.
  assertPlanContained(plan, input.bundleRoot)
  const executionPlan = planCompactionExecution({ bundleRoot: input.bundleRoot, plan })
  const dryRun = input.dryRun ?? false

  if (plan.empty || executionPlan.statements.length === 0) {
    return { plan, executionPlan, results: [], empty: true, dryRun, manifestPath: null }
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
    return { plan, executionPlan, results, empty: false, dryRun, manifestPath: null }
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

  // CQ-117: persist the compact manifest so the analytics runtime
  // (and any audit/GC consumer) can discover which live segments
  // are superseded by the compacted outputs. The manifest is the
  // single source of truth for "this live segment is no longer
  // canonical"; without it, consumers reading the live + compacted
  // overlays would double-count rows. The persisted manifest is
  // bundle-internal state — `writeCompactManifestV2` enforces the
  // same CQ-094/CQ-098/CQ-103 containment rules as the index
  // checkpoint store.
  const manifest = buildCompactManifestV2({
    plan,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  })
  const manifestPath = await writeCompactManifestV2(input.bundleRoot, manifest)

  return { plan, executionPlan, results, empty: false, dryRun, manifestPath }
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * CQ-118: validate every caller-supplied path inside a
 * `CompactionPlan` against the bundle root. Rejects absolute paths,
 * `..` traversal, and any resolved path outside `bundleRoot`. Runs
 * before the execution-plan composer touches the path string and
 * before any DuckDB / `mkdir` / `COPY` side effect.
 *
 * Throws a single `Error` on the first escape; the offending value
 * is quoted in the message so an operator can identify the
 * offending plan field. A planner-generated plan (built via
 * `planCompaction(bundleRoot)`) always passes this check.
 */
export function assertPlanContained(plan: CompactionPlan, bundleRoot: string): void {
  const rootAbs = resolvePath(bundleRoot)
  for (const entity of plan.entities) {
    for (const segment of entity.segmentsToMerge) {
      assertContained(segment.path, rootAbs, `segmentsToMerge[].path for entity ${entity.entityType}`)
    }
    assertContained(entity.outputPath, rootAbs, `outputPath for entity ${entity.entityType}`)
  }
}

function assertContained(path: string, rootAbs: string, label: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`assertPlanContained: ${label} is empty or not a string`)
  }
  if (isAbsolute(path)) {
    throw new Error(`assertPlanContained: ${label} ${JSON.stringify(path)} is absolute; must be relative to bundleRoot`)
  }
  // Reject explicit `..` traversal segments regardless of whether
  // the resolved path happens to stay inside the bundle. This is
  // belt-and-braces and matches CQ-094-style hardening.
  for (const part of path.split(/[\\/]/)) {
    if (part === '..') {
      throw new Error(`assertPlanContained: ${label} ${JSON.stringify(path)} contains '..' traversal`)
    }
  }
  const resolved = resolvePath(rootAbs, path)
  const rel = relative(rootAbs, resolved)
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `assertPlanContained: ${label} ${JSON.stringify(path)} resolves outside bundleRoot (${JSON.stringify(resolved)})`,
    )
  }
}
