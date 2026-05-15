import type { Bundle } from '@c3-oss/prosa-core'

export type UploadCounts = {
  sessions: number
  searchDocs: number
  sourceFiles: number
  rawRecords: number
  casObjects: number
  totalRows: number
  oversizedCasObjects: number
}

export type SyncLimits = {
  maxObjectsPerPlan: number
  maxRowsPerCommit: number
  maxObjectBytes: number
}

function readCount(bundle: Bundle, sql: string, params: unknown[] = []): number {
  const row = bundle.db.prepare(sql).get(...params) as { count: number | bigint } | undefined
  return Number(row?.count ?? 0)
}

export function readUploadCounts(bundle: Bundle, limits: SyncLimits): UploadCounts {
  const sessions = readCount(bundle, 'SELECT count(*) AS count FROM sessions')
  const searchDocs = readCount(bundle, 'SELECT count(*) AS count FROM search_docs WHERE session_id IS NOT NULL')
  const sourceFiles = readCount(bundle, 'SELECT count(*) AS count FROM source_files')
  const rawRecords = readCount(bundle, 'SELECT count(*) AS count FROM raw_records')
  const casObjects = readCount(bundle, 'SELECT count(*) AS count FROM objects')
  const oversizedCasObjects = readCount(
    bundle,
    `SELECT count(*) AS count
       FROM objects
      WHERE size_bytes > ?
         OR COALESCE(compressed_size_bytes, size_bytes) > ?`,
    [limits.maxObjectBytes, limits.maxObjectBytes],
  )
  return {
    sessions,
    searchDocs,
    sourceFiles,
    rawRecords,
    casObjects,
    totalRows: sessions + searchDocs + sourceFiles + rawRecords,
    oversizedCasObjects,
  }
}

export function uploadLimitViolations(counts: UploadCounts, limits: SyncLimits): string[] {
  const violations: string[] = []
  if (counts.casObjects > limits.maxObjectsPerPlan) {
    violations.push(
      `CAS object count ${counts.casObjects} exceeds server maxObjectsPerPlan ${limits.maxObjectsPerPlan}`,
    )
  }
  if (counts.totalRows > limits.maxRowsPerCommit) {
    violations.push(
      `projection row count ${counts.totalRows} exceeds server maxRowsPerCommit ${limits.maxRowsPerCommit}`,
    )
  }
  if (counts.oversizedCasObjects > 0) {
    violations.push(`${counts.oversizedCasObjects} CAS object(s) exceed server maxObjectBytes ${limits.maxObjectBytes}`)
  }
  return violations
}
