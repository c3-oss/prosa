// DuckDB analytics runtime executor.
//
// Closes the loop on the Lane 3 analytics path:
//
//   1. `planAnalyticsExecution(...)` (in `./executor-plan.ts`) composes
//      the ordered statement sequence the runtime must issue: one
//      `CREATE OR REPLACE TEMP VIEW <entity>` per canonical entity
//      table bound to a Parquet read, followed by the
//      `CREATE OR REPLACE VIEW <analyticsView>` body.
//   2. This module opens a `@duckdb/node-api` connection, executes
//      those setup statements in order, runs the report query, and
//      returns `{ view, columns, rows }` to the caller.
//
// One real-world wrinkle: DuckDB's `read_parquet` raises an
// `IO Error: No files found that match the pattern …` when a glob
// matches zero files. The composer hands us both a live-segment glob
// (`epochs/*/projection/<entity>.parquet`) and a compacted glob
// (`epochs/compact-*/projection/<entity>.compacted.parquet`); the
// compacted overlay is almost always absent on a freshly-compiled
// bundle. The runtime therefore *probes* each glob before issuing
// the setup statement and rewrites the `read_parquet([...])` array
// to contain only globs with at least one match. When *both* globs
// are empty the runtime omits the temp-view setup entirely; the
// view body that references that entity will then fail with
// DuckDB's own `Table … does not exist` error, which is the right
// failure mode (the caller asked to analyse a bundle that has no
// Parquet for the entity).

import { glob } from 'node:fs/promises'

import {
  type AnalyticsExecutionPlan,
  type PlanAnalyticsExecutionInput,
  planAnalyticsExecution,
} from './executor-plan.js'
import { ANALYTICS_ENTITY_TABLES, type AnalyticsEntityTable, type AnalyticsViewName } from './views.js'

/** Single row of a runtime report query result. DuckDB returns JSON
 *  objects keyed by column name; the runtime forwards them verbatim
 *  so the caller can JSON-serialise the result without re-encoding. */
export type AnalyticsRow = Record<string, unknown>

export interface RunAnalyticsExecutionInput {
  /** Absolute bundle root. Passed through to
   *  `planAnalyticsExecution` when the caller does not provide a
   *  pre-composed plan, and used by the runtime to probe the
   *  parquet globs before issuing the setup statements. */
  bundleRoot: string
  /** Which analytics view to materialise. */
  view: AnalyticsViewName
  /** Optional custom report query. Defaults to
   *  `SELECT * FROM <view>;` via the composer. */
  reportQuery?: string
}

export interface RunAnalyticsExecutionResult {
  /** The view the executor materialised. Mirrors `input.view`. */
  view: AnalyticsViewName
  /** Column names in the order DuckDB returned them. */
  columns: string[]
  /** Result rows, in the order DuckDB returned them. */
  rows: AnalyticsRow[]
  /** Setup statements actually issued, in order. May be shorter
   *  than `plan.setupStatements` if the runtime dropped statements
   *  for entities whose parquet globs matched zero files. Exposed so
   *  CLI/MCP surfaces can show the operator exactly what ran. */
  executedSetupStatements: string[]
  /** Entities whose live + compacted parquet globs matched zero
   *  files; their `CREATE OR REPLACE TEMP VIEW` was skipped. Empty
   *  when every canonical entity had at least one segment on disk. */
  skippedEntities: AnalyticsEntityTable[]
}

/** Lazy native module reference. */
type DuckDbModule = typeof import('@duckdb/node-api')

async function loadDuckDb(): Promise<DuckDbModule> {
  return await import('@duckdb/node-api')
}

/**
 * Materialise an analytics view against the bundle's Parquet
 * projection segments and run the report query. Opens its own
 * in-process DuckDB connection so callers do not need to manage one.
 *
 * `reportQuery` defaults to `SELECT * FROM <view>;` via the
 * composer. The result preserves DuckDB's column ordering for
 * `columns`; the caller is responsible for asserting it matches
 * the `ANALYTICS_VIEW_COLUMNS[view]` contract (the runtime does
 * not enforce shape parity — that is a higher-level test
 * concern).
 *
 * Throws when:
 *
 *   - the dynamic import of `@duckdb/node-api` fails;
 *   - any setup statement raises an error (typically because an
 *     entity that the view body references has no parquet
 *     segments on disk — see the module-level comment);
 *   - the report query itself raises an error.
 *
 * The DuckDB connection is closed in a `finally` block so a
 * crash in any of the above paths still releases the connection.
 */
export async function runAnalyticsExecution(input: RunAnalyticsExecutionInput): Promise<RunAnalyticsExecutionResult> {
  const planInput: PlanAnalyticsExecutionInput = {
    bundleRoot: input.bundleRoot,
    view: input.view,
    reportQuery: input.reportQuery,
  }
  const plan = planAnalyticsExecution(planInput)

  const { executedSetupStatements, skippedEntities } = await resolveRuntimeSetupStatements(plan, input.bundleRoot)

  const duckdb = await loadDuckDb()
  const connection = await duckdb.DuckDBConnection.create()
  try {
    for (const stmt of executedSetupStatements) {
      await connection.run(stmt)
    }
    const reader = await connection.runAndReadAll(plan.reportQuery)
    return {
      view: plan.view,
      columns: reader.deduplicatedColumnNames(),
      rows: reader.getRowObjectsJson() as AnalyticsRow[],
      executedSetupStatements,
      skippedEntities,
    }
  } finally {
    connection.closeSync()
  }
}

/** Probe each entity's parquet globs and rewrite the setup
 *  statements to reference only the globs with at least one match.
 *  Statements that would degrade to an empty `read_parquet([])` are
 *  dropped entirely; their entities are reported in
 *  `skippedEntities` so callers see exactly what the runtime
 *  omitted. */
async function resolveRuntimeSetupStatements(
  plan: AnalyticsExecutionPlan,
  bundleRoot: string,
): Promise<{ executedSetupStatements: string[]; skippedEntities: AnalyticsEntityTable[] }> {
  const live = new Map<AnalyticsEntityTable, string>()
  const compact = new Map<AnalyticsEntityTable, string>()
  for (const entity of ANALYTICS_ENTITY_TABLES) {
    live.set(entity, `${bundleRoot}/epochs/*/projection/${entity}.parquet`)
    compact.set(entity, `${bundleRoot}/epochs/compact-*/projection/${entity}.compacted.parquet`)
  }

  const executedSetupStatements: string[] = []
  const skippedEntities: AnalyticsEntityTable[] = []

  // The plan emits one `CREATE OR REPLACE TEMP VIEW <entity> …`
  // statement per canonical entity, followed by exactly one analytics
  // `CREATE OR REPLACE VIEW <view> …` body. The runtime walks the
  // statements in order: entity statements are rewritten / skipped;
  // the analytics view body is passed through verbatim.
  for (let i = 0; i < plan.setupStatements.length; i++) {
    const stmt = plan.setupStatements[i] as string
    const entity = entityFromTempViewStatement(stmt)
    if (entity === null) {
      // Analytics view body or any other passthrough statement.
      executedSetupStatements.push(stmt)
      continue
    }
    const livePath = live.get(entity) as string
    const compactPath = compact.get(entity) as string
    const [liveHits, compactHits] = await Promise.all([globHits(livePath), globHits(compactPath)])
    if (!liveHits && !compactHits) {
      skippedEntities.push(entity)
      continue
    }
    const present: string[] = []
    if (liveHits) present.push(livePath)
    if (compactHits) present.push(compactPath)
    const replacement = `read_parquet([${present.map((p) => quoteSqlString(p)).join(', ')}], union_by_name => true)`
    executedSetupStatements.push(rewriteReadParquetClause(stmt, replacement))
  }

  return { executedSetupStatements, skippedEntities }
}

/** Pull the canonical entity name out of a
 *  `CREATE OR REPLACE TEMP VIEW <entity> AS …` statement. Returns
 *  `null` for any statement that does not match (e.g. the analytics
 *  view body, or anything a future composer adds). */
function entityFromTempViewStatement(stmt: string): AnalyticsEntityTable | null {
  const match = /CREATE\s+OR\s+REPLACE\s+TEMP\s+VIEW\s+([a-z_]+)\s+AS/i.exec(stmt)
  if (match === null) return null
  const candidate = match[1] as AnalyticsEntityTable
  if (!(ANALYTICS_ENTITY_TABLES as readonly string[]).includes(candidate)) return null
  return candidate
}

/** Swap the existing `read_parquet([...], union_by_name => true)`
 *  call with the runtime-built replacement. Anchored at
 *  `read_parquet(` to be conservative — the composer always emits
 *  exactly one such call per setup statement. */
function rewriteReadParquetClause(stmt: string, replacement: string): string {
  const start = stmt.indexOf('read_parquet(')
  if (start < 0) return stmt
  let depth = 0
  let end = -1
  for (let i = start + 'read_parquet'.length; i < stmt.length; i++) {
    const ch = stmt[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) return stmt
  return `${stmt.slice(0, start)}${replacement}${stmt.slice(end)}`
}

/** True iff the glob matches at least one filesystem entry. Uses
 *  `node:fs/promises.glob` (Node 22+) and short-circuits on the
 *  first hit. */
async function globHits(pattern: string): Promise<boolean> {
  // `glob` is async-iterable; consuming the first entry is enough.
  for await (const _entry of glob(pattern)) {
    void _entry
    return true
  }
  return false
}

/** Single-quote a value for SQL string literals, doubling embedded
 *  single quotes per the SQL standard. Mirrors the helper in
 *  `views.ts` but kept local so this module has no internal-only
 *  dependency on the composer's private helpers. */
function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
