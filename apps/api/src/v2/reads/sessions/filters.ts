// Lane 6 — session-list filter builder.
//
// Centralizes the SQL fragment + parameter array construction shared
// by `sessions/list`, `sessions/count`, and the cross-store
// aggregation paths. Every clause routes through the
// verified-projection gate so a row without current authority for the
// (tenant, store) tuple stays invisible no matter which filter
// combination is supplied.

import { z } from 'zod'
import { verifiedProjectionWhere } from '../shared/verified-projection.js'

export const sessionListFilters = z.object({
  sourceTools: z.array(z.string().min(1)).optional(),
  projectIds: z.array(z.string().min(1)).optional(),
  storeIds: z.array(z.string().min(1)).optional(),
  /** ISO 8601 lower bound (inclusive) on `start_ts`. */
  since: z.string().optional(),
  /** ISO 8601 upper bound (exclusive) on `start_ts`. */
  until: z.string().optional(),
  /** Case-insensitive substring match against `title`. */
  q: z.string().min(1).optional(),
})

export type SessionListFilters = z.infer<typeof sessionListFilters>

function appendParam(params: unknown[], value: unknown): string {
  params.push(value)
  return `$${params.length}`
}

export type BuiltSessionFilter = {
  whereSql: string
  params: unknown[]
}

/**
 * Build the WHERE clause + positional parameters. `$1` is always the
 * caller's tenant id; the verified-projection gate cross-references
 * it so every additional filter inherits the receipt-pinned scope.
 */
export function buildSessionWhere(tenantId: string, filters: SessionListFilters): BuiltSessionFilter {
  const params: unknown[] = [tenantId]
  const clauses: string[] = [verifiedProjectionWhere('s', '$1')]

  if (filters.sourceTools && filters.sourceTools.length > 0) {
    const placeholders = filters.sourceTools.map((t) => appendParam(params, t)).join(', ')
    clauses.push(`s.source_tool IN (${placeholders})`)
  }
  if (filters.projectIds && filters.projectIds.length > 0) {
    const placeholders = filters.projectIds.map((p) => appendParam(params, p)).join(', ')
    clauses.push(`s.project_id IN (${placeholders})`)
  }
  if (filters.storeIds && filters.storeIds.length > 0) {
    const placeholders = filters.storeIds.map((p) => appendParam(params, p)).join(', ')
    clauses.push(`s.store_id IN (${placeholders})`)
  }
  if (filters.since) {
    const param = appendParam(params, filters.since)
    clauses.push(`s.start_ts >= ${param}::timestamptz`)
  }
  if (filters.until) {
    const param = appendParam(params, filters.until)
    clauses.push(`s.start_ts < ${param}::timestamptz`)
  }
  if (filters.q) {
    const param = appendParam(params, `%${filters.q}%`)
    clauses.push(`s.title ILIKE ${param}`)
  }

  return { whereSql: clauses.join(' AND '), params }
}

export { appendParam }
