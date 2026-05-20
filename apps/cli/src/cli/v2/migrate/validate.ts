// Lane 9 — migration count validation.
//
// `validateMigrationCounts` compares the load-bearing row/object counts
// between the v1 bundle (`source_files`, `raw_records`, `sessions`,
// `objects`, `search_docs`) and the freshly assembled v2 bundle. The
// policy mirrors `docs/rearch-2/10-lane-9-migration.md`:
//
//   - `sourceFiles`, `rawRecords`, `sessions` must match exactly,
//   - `objects` may shrink (v2 may consolidate) but never grow,
//   - `searchDocs` is allowed ±1 % variance to absorb derived
//     re-computation differences.
//
// The result is plain-data so the caller can render it under
// `--verbose` or `--json` and so tests can assert on the diff
// independently of any console output.
//
// This module deliberately does not throw. The caller decides whether
// a non-`ok` validation aborts the migration (see `migrateBundle`,
// which refuses the atomic rename when `ok === false`).

import type { Bundle as BundleV2 } from '@c3-oss/prosa-bundle-v2'
import type { Bundle as BundleV1 } from '@c3-oss/prosa-core'

/** Per-table count snapshot taken from either bundle. */
export type MigrationCounts = {
  sourceFiles: number
  rawRecords: number
  sessions: number
  objects: number
  searchDocs: number
}

export type MigrationCountDiff = {
  sourceFiles: number
  rawRecords: number
  sessions: number
  objects: number
  searchDocs: number
}

export type MigrationValidation = {
  ok: boolean
  v1Counts: MigrationCounts
  v2Counts: MigrationCounts
  diff: MigrationCountDiff
  /**
   * Human-readable reasons each load-bearing dimension failed. Empty
   * array implies `ok === true`.
   */
  reasons: string[]
}

const SEARCH_DOC_VARIANCE = 0.01

/**
 * Compare v1 and v2 counts. The v2 bundle's `head.counts` is the
 * authoritative source — at migration time the v2 bundle is sealed
 * before validation runs.
 */
export async function validateMigrationCounts(v1: BundleV1, v2: BundleV2): Promise<MigrationValidation> {
  const v1Counts = readV1Counts(v1)
  const v2Counts = readV2Counts(v2)

  const diff: MigrationCountDiff = {
    sourceFiles: v2Counts.sourceFiles - v1Counts.sourceFiles,
    rawRecords: v2Counts.rawRecords - v1Counts.rawRecords,
    sessions: v2Counts.sessions - v1Counts.sessions,
    objects: v2Counts.objects - v1Counts.objects,
    searchDocs: v2Counts.searchDocs - v1Counts.searchDocs,
  }

  const reasons: string[] = []
  if (diff.sourceFiles !== 0) {
    reasons.push(`sourceFiles drift: v1=${v1Counts.sourceFiles} v2=${v2Counts.sourceFiles} diff=${diff.sourceFiles}`)
  }
  if (diff.rawRecords !== 0) {
    reasons.push(`rawRecords drift: v1=${v1Counts.rawRecords} v2=${v2Counts.rawRecords} diff=${diff.rawRecords}`)
  }
  if (diff.sessions !== 0) {
    reasons.push(`sessions drift: v1=${v1Counts.sessions} v2=${v2Counts.sessions} diff=${diff.sessions}`)
  }
  if (diff.objects > 0) {
    reasons.push(`objects exceeded v1 count: v1=${v1Counts.objects} v2=${v2Counts.objects} diff=${diff.objects}`)
  }
  const searchTolerance = Math.max(1, Math.ceil(v1Counts.searchDocs * SEARCH_DOC_VARIANCE))
  if (Math.abs(diff.searchDocs) > searchTolerance) {
    reasons.push(
      `searchDocs variance > ${(SEARCH_DOC_VARIANCE * 100).toFixed(0)}%: ` +
        `v1=${v1Counts.searchDocs} v2=${v2Counts.searchDocs} diff=${diff.searchDocs} tolerance=${searchTolerance}`,
    )
  }

  return {
    ok: reasons.length === 0,
    v1Counts,
    v2Counts,
    diff,
    reasons,
  }
}

/** Count every load-bearing v1 table. */
export function readV1Counts(v1: BundleV1): MigrationCounts {
  return {
    sourceFiles: countTable(v1, 'source_files'),
    rawRecords: countTable(v1, 'raw_records'),
    sessions: countTable(v1, 'sessions'),
    objects: countTable(v1, 'objects'),
    searchDocs: countTable(v1, 'search_docs'),
  }
}

/** Read the v2 counts from the sealed `head.counts` snapshot. */
export function readV2Counts(v2: BundleV2): MigrationCounts {
  const c = v2.head.counts
  return {
    sourceFiles: c.sourceFiles,
    rawRecords: c.rawRecords,
    sessions: c.sessions,
    objects: c.objects,
    searchDocs: c.searchDocs,
  }
}

function countTable(v1: BundleV1, table: string): number {
  // v1 only ships the tables enumerated in the schema migrations; if
  // a fixture omits one (e.g. `search_docs` on a freshly-imported
  // bundle that never ran the indexer), treat the count as zero.
  try {
    const row = v1.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined
    return row?.n ?? 0
  } catch {
    return 0
  }
}
