// Local-bundle implementations of `prosa read analytics <report>` and
// `prosa read query '<sql>'`.
//
// Both delegate to `runAnalyticsExecution`, which is already wired up
// to read NDJSON projection segments via DuckDB. The CLI's report
// argument maps to a canonical analytics view name; the ad-hoc query
// path passes its SQL through verbatim.

import { runAnalyticsExecution } from '../analytics/runtime-executor.js'
import type { AnalyticsViewName } from '../analytics/views.js'
import { loadBundleHead } from './head.js'

export type LocalAnalyticsReport = 'sessions' | 'tools' | 'errors' | 'models' | 'projects'

const REPORT_TO_VIEW: Record<LocalAnalyticsReport, AnalyticsViewName> = {
  sessions: 'session_facts',
  tools: 'tool_usage_facts',
  errors: 'error_facts',
  models: 'model_usage',
  projects: 'project_activity',
}

export type RunAnalyticsLocalOptions = {
  bundleRoot: string
  report: LocalAnalyticsReport
  sourceTools?: string[]
  sinceIso?: string | null
  untilIso?: string | null
  limit: number
}

export type LocalAnalyticsResult = {
  view: AnalyticsViewName
  columns: string[]
  rows: Record<string, unknown>[]
  epoch: number
}

function buildWhereClause(options: RunAnalyticsLocalOptions): string {
  const clauses: string[] = []
  if (options.sourceTools && options.sourceTools.length > 0) {
    const inlined = options.sourceTools.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')
    clauses.push(`source_tool IN (${inlined})`)
  }
  if (options.sinceIso) clauses.push(`start_ts >= '${options.sinceIso.replace(/'/g, "''")}'`)
  if (options.untilIso) clauses.push(`start_ts < '${options.untilIso.replace(/'/g, "''")}'`)
  return clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
}

/**
 * Resolve the report to its canonical analytics view and run the
 * DuckDB-backed executor. Returns the materialised rows the CLI
 * pretty-prints; column names match what `runAnalyticsExecution`
 * emits.
 */
export async function runAnalyticsLocal(options: RunAnalyticsLocalOptions): Promise<LocalAnalyticsResult> {
  const head = await loadBundleHead(options.bundleRoot)
  const view = REPORT_TO_VIEW[options.report]
  const where = buildWhereClause(options)
  const reportQuery = `SELECT * FROM ${view}${where} LIMIT ${Math.max(0, Math.floor(options.limit))}`
  const result = await runAnalyticsExecution({ bundleRoot: options.bundleRoot, view, reportQuery })
  return {
    view,
    columns: result.columns,
    rows: result.rows as Record<string, unknown>[],
    epoch: head.epoch,
  }
}

export type RunQueryLocalOptions = {
  bundleRoot: string
  /** Operator-supplied DuckDB SQL run against the analytics view set. */
  sql: string
  /** Optional view name to make sure every entity table is wired in;
   *  defaults to `session_facts` which references the broadest set. */
  view?: AnalyticsViewName
}

export async function runQueryLocal(options: RunQueryLocalOptions): Promise<LocalAnalyticsResult> {
  const head = await loadBundleHead(options.bundleRoot)
  const view = options.view ?? 'session_facts'
  const result = await runAnalyticsExecution({ bundleRoot: options.bundleRoot, view, reportQuery: options.sql })
  return {
    view,
    columns: result.columns,
    rows: result.rows as Record<string, unknown>[],
    epoch: head.epoch,
  }
}
