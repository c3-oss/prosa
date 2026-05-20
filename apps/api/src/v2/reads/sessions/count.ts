// Lane 6 — `POST /v2/reads/sessions/count` handler.
//
// Cheap aggregate: applies the same filters + verified-projection
// gate as `sessions/list`, then collapses cross-store duplicates so
// the count agrees with what a paginated list iteration would
// surface. `COUNT(DISTINCT (source_tool, source_session_id))` keeps
// the gate-aware filter scope while preserving the lane invariant
// that a logical session promoted by N stores collapses to one row.

import type { z } from 'zod'
import type { RawExec } from '../../../db.js'
import { type SessionListFilters, buildSessionWhere, sessionListFilters } from './filters.js'

export const countSessionsInput = sessionListFilters

export type CountSessionsInput = z.infer<typeof countSessionsInput>

export type CountSessionsResponse = { count: number }

export type CountSessionsDeps = {
  rawExec: RawExec
}

export async function countSessions(
  deps: CountSessionsDeps,
  tenantId: string,
  input: CountSessionsInput,
): Promise<CountSessionsResponse> {
  const filters: SessionListFilters = input
  const { whereSql, params } = buildSessionWhere(tenantId, filters)
  const sql = `
    SELECT COUNT(*)::int AS count FROM (
      SELECT DISTINCT s.source_tool, s.source_session_id
        FROM projection_session s
       WHERE ${whereSql}
    ) conflict_resolved
  `
  const rows = await deps.rawExec<{ count: number }>(sql, params)
  return { count: rows[0]?.count ?? 0 }
}
