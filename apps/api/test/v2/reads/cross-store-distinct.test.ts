// Lane 6 / CQ-147 — analytics cross-store distinct acceptance.
//
// When a logical session is promoted by N current stores, every
// analytics aggregate must count it exactly once. The reviewer's
// smoke flagged that the slice 8 summary returned `sessions: 2`
// for a single-logical / two-store fixture, and tools / models
// double-counted invocations / messages. This suite pins the
// fix:
//
//   summary.counts.sessions          == 1
//   summary.sources[codex].count     == 1
//   summary.stores                   has one entry per store but
//                                    only the picked store holds
//                                    the logical session
//   report 'sessions'                returns one row
//   report 'tools'                   invocation_count == 1
//   report 'models'                  message_count == messages
//                                    in the picked session only
//
// The schema strictness check is in `analytics-report-strict.test.ts`.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAnalyticsReport } from '../../../src/v2/reads/analytics/report.js'
import { getAnalyticsSummary } from '../../../src/v2/reads/analytics/summary.js'

const tenantId = 't_a'

function makeRawExec(db: PGlite) {
  return async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await db.query<Row>(sql, params)
    return res.rows
  }
}

describe('Lane 6 analytics — CQ-147 cross-store distinct invariants', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    // Both stores are current authority — the same logical session
    // is promoted by both. Without CQ-147 every aggregate doubles.
    await db.query(
      `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, 's_old', 'rcp_old', 'aa', now()),
              ($1, 's_new', 'rcp_new', 'bb', now())`,
      [tenantId],
    )
    // Same (source_tool, source_session_id) tuple — two physical
    // session rows, one logical session.
    await db.query(
      `INSERT INTO projection_session
         (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
          parent_resolution, timeline_confidence, start_ts, end_ts, payload)
       VALUES
         ($1, 'ses_old', 's_old', 'rcp_old', 'codex', 'src_shared', 'unresolved', 'high',
          '2026-05-15T10:00:00Z'::timestamptz, '2026-05-15T10:30:00Z'::timestamptz, '{}'::jsonb),
         ($1, 'ses_new', 's_new', 'rcp_new', 'codex', 'src_shared', 'unresolved', 'high',
          '2026-05-19T10:00:00Z'::timestamptz, '2026-05-19T11:00:00Z'::timestamptz, '{}'::jsonb)`,
      [tenantId],
    )
    // The picked logical session is `ses_new` (freshest end_ts).
    // Tool calls + messages live on `ses_new` only — putting them on
    // the *picked* row reflects what the materialization path would
    // do once Lane 10 cuts over (each promotion gets its own copy).
    await db.query(
      `INSERT INTO projection_tool_call
         (tenant_id, tool_call_id, store_id, receipt_id, session_id, tool_name, payload)
       VALUES
         ($1, 'tc_new', 's_new', 'rcp_new', 'ses_new', 'bash', '{}'::jsonb)`,
      [tenantId],
    )
    await db.query(
      `INSERT INTO projection_message
         (tenant_id, message_id, store_id, receipt_id, session_id, role, model, ordinal, payload)
       VALUES
         ($1, 'msg_new', 's_new', 'rcp_new', 'ses_new', 'user', 'gpt-5', 0, '{}'::jsonb)`,
      [tenantId],
    )
  })
  afterEach(async () => {
    await db.close()
  })

  it('summary collapses cross-store duplicates: sessions == 1 (not 2)', async () => {
    const out = await getAnalyticsSummary({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId)
    expect(out.counts.sessions).toBe(1)
    expect(out.counts.sources).toBe(1)
    const codexCount = out.sources.find((s) => s.sourceTool === 'codex')?.count
    expect(codexCount).toBe(1)
    // Picked-sessions place src_shared in s_new (freshest end_ts).
    const storeMap = Object.fromEntries(out.stores.map((s) => [s.storeId, s.sessionCount]))
    expect(storeMap.s_new).toBe(1)
    expect(storeMap.s_old ?? 0).toBe(0)
  })

  it('summary tool-call count counts the logical invocation once', async () => {
    const out = await getAnalyticsSummary({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId)
    expect(out.counts.toolCalls).toBe(1)
    expect(out.counts.messages).toBe(1)
  })

  it('sessions report returns one row for the logical session', async () => {
    const out = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'sessions',
      limit: 100,
    })
    expect(out.rows.length).toBe(1)
    expect(out.rows[0]?.session_id).toBe('ses_new')
    expect(out.rows[0]?.store_id).toBe('s_new')
  })

  it('tools report counts the invocation once', async () => {
    const out = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'tools',
      limit: 100,
    })
    const bash = out.rows.find((r) => r.tool_name === 'bash')
    expect(bash?.invocation_count).toBe(1)
    expect(bash?.distinct_sessions).toBe(1)
  })

  it('models report counts the message once', async () => {
    const out = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'models',
      limit: 100,
    })
    const gpt = out.rows.find((r) => r.model === 'gpt-5')
    expect(gpt?.message_count).toBe(1)
    expect(gpt?.distinct_sessions).toBe(1)
  })

  it('tools / errors reports ignore current-authority tool_result with mismatched session_id (CQ-147 follow-up)', async () => {
    // Seed a *current-authority* tool_result that shares store/receipt/
    // tool_call_id with the current call, but the session_id does NOT
    // match the call's session. Without `r.session_id = c.session_id`
    // the EXISTS subquery would mark tc_new as errored even though the
    // wrong-session result belongs to a different logical call. The
    // regression is the governor's slice 10 smoke output.
    await db.query(
      `INSERT INTO projection_tool_result
         (tenant_id, tool_result_id, store_id, receipt_id, tool_call_id, session_id,
          status, is_error, payload)
       VALUES ($1, 'tr_wrong_session', 's_new', 'rcp_new',
               'tc_new', 'ses_wrong', 'failure', TRUE, '{}'::jsonb)`,
      [tenantId],
    )

    const tools = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'tools',
      limit: 100,
    })
    const bash = tools.rows.find((r) => r.tool_name === 'bash')
    // The mismatched session_id must NOT count as an error for tc_new.
    expect(bash?.error_count).toBe(0)

    const errors = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'errors',
      limit: 100,
    })
    expect(errors.rows).toEqual([])
  })

  it('tools / errors reports ignore superseded tool_result rows (CQ-147 follow-up)', async () => {
    // Seed a *superseded* tool_result that would mark the call as
    // errored if the report failed to apply
    // `verifiedProjectionWhere('r')`. The current-authority result
    // (none) means the call must NOT count as an error.
    await db.query(
      `INSERT INTO projection_tool_result
         (tenant_id, tool_result_id, store_id, receipt_id, tool_call_id, session_id,
          status, is_error, payload)
       VALUES ($1, 'tr_superseded', 's_new', 'rcp_superseded',
               'tc_new', 'ses_new', 'failure', TRUE, '{}'::jsonb)`,
      [tenantId],
    )

    const tools = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'tools',
      limit: 100,
    })
    const bash = tools.rows.find((r) => r.tool_name === 'bash')
    // tc_new has no current-authority error result, so error_count stays 0.
    expect(bash?.error_count).toBe(0)

    const errors = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'errors',
      limit: 100,
    })
    // No tool with a current-authority error → empty rows.
    expect(errors.rows).toEqual([])
  })
})

describe('Lane 6 analytics report input — CQ-147 strictness', () => {
  it('rejects unknown filter keys at the wire boundary instead of silently dropping them', async () => {
    const { analyticsReportInput } = await import('../../../src/v2/reads/analytics/report.js')
    const parsed = analyticsReportInput.safeParse({ report: 'sessions', notARealFilter: 'gpt-5', limit: 10 })
    expect(parsed.success).toBe(false)
  })

  it('accepts the documented filter set', async () => {
    const { analyticsReportInput } = await import('../../../src/v2/reads/analytics/report.js')
    const parsed = analyticsReportInput.safeParse({
      report: 'tools',
      sourceTools: ['codex'],
      since: '2026-05-19T00:00:00Z',
      until: '2026-05-21T00:00:00Z',
      limit: 50,
    })
    expect(parsed.success).toBe(true)
  })
})
