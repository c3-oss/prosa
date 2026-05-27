// Lane 6 — `GET /v2/reads/analytics/summary` handler.
//
// Lightweight gate-aware aggregate. Every count subquery composes
// the verified-projection gate so a dashboard never reports counts
// that include superseded rows. The store breakdown also reports
// the latest `promoted_at` per store so operators can spot a stuck
// store at a glance.

import type { RawExec } from '../../../db.js'
import { verifiedProjectionWhere, verifiedSearchWhere } from '../shared/verified-projection.js'

export type AnalyticsSummaryResponse = {
  generatedAt: string
  counts: {
    sessions: number
    messages: number
    toolCalls: number
    toolResultErrors: number
    artifacts: number
    searchDocs: number
    stores: number
    sources: number
  }
  sources: Array<{ sourceTool: string; count: number }>
  stores: Array<{ storeId: string; sessionCount: number; latestPromotedAt: string | null }>
}

export type AnalyticsSummaryDeps = {
  rawExec: RawExec
  /** Override for tests; defaults to `new Date()`. */
  now?: () => Date
}

/**
 * CQ-147: cross-store distinct CTE used by every analytics
 * subquery. Collapses duplicates of the same logical session
 * (`(source_tool, source_session_id)`) by picking the freshest
 * `(end_ts, receipt_id)` — same rule as `sessions/list`. Subqueries
 * then `JOIN` against `picked_sessions` to count messages / tool
 * calls / tool result errors / artifacts that belong to the
 * collapsed session id set. Without this CTE a logical session
 * promoted by N stores would inflate every aggregate by a factor
 * of N.
 */
const CROSS_STORE_DISTINCT_CTE = `
  WITH picked_sessions AS (
    SELECT DISTINCT ON (s.source_tool, s.source_session_id)
           s.session_id, s.source_tool, s.store_id, s.receipt_id
      FROM projection_session s
     WHERE ${verifiedProjectionWhere('s', '$1')}
     ORDER BY s.source_tool, s.source_session_id, s.end_ts DESC NULLS LAST, s.receipt_id DESC
  )
`

export async function getAnalyticsSummary(
  deps: AnalyticsSummaryDeps,
  tenantId: string,
): Promise<AnalyticsSummaryResponse> {
  const counts = await deps.rawExec<{
    sessions: number
    messages: number
    tool_calls: number
    tool_result_errors: number
    artifacts: number
    search_docs: number
    stores: number
    sources: number
  }>(
    `${CROSS_STORE_DISTINCT_CTE}
     SELECT
       (SELECT count(*)::int FROM picked_sessions) AS sessions,
       (SELECT count(*)::int FROM projection_message m
          JOIN picked_sessions ps ON ps.session_id = m.session_id
         WHERE ${verifiedProjectionWhere('m')}) AS messages,
       (SELECT count(*)::int FROM projection_tool_call c
          JOIN picked_sessions ps ON ps.session_id = c.session_id
         WHERE ${verifiedProjectionWhere('c')}) AS tool_calls,
       (SELECT count(*)::int FROM projection_tool_result r
          JOIN picked_sessions ps ON ps.session_id = r.session_id
         WHERE ${verifiedProjectionWhere('r')} AND r.is_error = TRUE) AS tool_result_errors,
       (SELECT count(*)::int FROM projection_artifact a
          LEFT JOIN picked_sessions ps ON ps.session_id = a.session_id
         WHERE ${verifiedProjectionWhere('a')}
           AND (a.session_id IS NULL OR ps.session_id IS NOT NULL)) AS artifacts,
       (SELECT count(*)::int FROM search_doc d WHERE ${verifiedSearchWhere('d')}) AS search_docs,
       (SELECT count(*)::int FROM remote_authority_v2 ra WHERE ra.tenant_id = $1) AS stores,
       (SELECT count(DISTINCT ps.source_tool)::int FROM picked_sessions ps) AS sources`,
    [tenantId],
  )

  const sources = await deps.rawExec<{ source_tool: string; count: number }>(
    `${CROSS_STORE_DISTINCT_CTE}
     SELECT ps.source_tool, count(*)::int AS count
       FROM picked_sessions ps
      GROUP BY ps.source_tool
      ORDER BY count DESC, ps.source_tool ASC`,
    [tenantId],
  )

  const stores = await deps.rawExec<{ store_id: string; session_count: number; promoted_at: string | null }>(
    `${CROSS_STORE_DISTINCT_CTE}
     SELECT ps.store_id,
            count(*)::int AS session_count,
            to_char(MAX(ra.promoted_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS promoted_at
       FROM picked_sessions ps
       LEFT JOIN remote_authority_v2 ra
         ON ra.tenant_id = $1 AND ra.store_id = ps.store_id
      GROUP BY ps.store_id
      ORDER BY session_count DESC, ps.store_id ASC`,
    [tenantId],
  )

  const aggregate = counts[0] ?? {
    sessions: 0,
    messages: 0,
    tool_calls: 0,
    tool_result_errors: 0,
    artifacts: 0,
    search_docs: 0,
    stores: 0,
    sources: 0,
  }

  return {
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    counts: {
      sessions: aggregate.sessions,
      messages: aggregate.messages,
      toolCalls: aggregate.tool_calls,
      toolResultErrors: aggregate.tool_result_errors,
      artifacts: aggregate.artifacts,
      searchDocs: aggregate.search_docs,
      stores: aggregate.stores,
      sources: aggregate.sources,
    },
    sources: sources.map((row) => ({ sourceTool: row.source_tool, count: row.count })),
    stores: stores.map((row) => ({
      storeId: row.store_id,
      sessionCount: row.session_count,
      latestPromotedAt: row.promoted_at,
    })),
  }
}
