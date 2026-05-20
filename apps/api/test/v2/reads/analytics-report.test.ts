// Lane 6 — analytics/summary + analytics/report pin.
//
// Each report runs against a fresh v2-only PGlite seeded with a
// repeatable shape: two stores, three logical sessions (one
// cross-store duplicate), a few messages / tool calls / tool
// results / artifacts / search docs. The verified-projection gate
// is exercised by leaving one row under a superseded receipt for
// every projection table — the analytics totals must never reflect
// those superseded rows.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAnalyticsReport } from '../../../src/v2/reads/analytics/report.js'
import { getAnalyticsSummary } from '../../../src/v2/reads/analytics/summary.js'

function makeRawExec(db: PGlite) {
  return async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await db.query<Row>(sql, params)
    return res.rows
  }
}

const tenantId = 't_a'
const otherTenant = 't_b'

async function seedAuthority(db: PGlite, tenant: string, storeId: string, receiptId: string) {
  await db.query(
    `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, store_id) DO UPDATE SET current_receipt_id = EXCLUDED.current_receipt_id`,
    [tenant, storeId, receiptId, 'aa'.repeat(16)],
  )
}

async function seedSession(
  db: PGlite,
  opts: {
    tenant: string
    storeId: string
    receiptId: string
    sessionId: string
    sourceTool?: string
    sourceSessionId?: string
    projectId?: string | null
    title?: string
    startTs: string | null
    endTs?: string | null
  },
) {
  await db.query(
    `INSERT INTO projection_session
       (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id, project_id,
        parent_resolution, timeline_confidence, title, start_ts, end_ts, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'unresolved', 'high', $8, $9::timestamptz, $10::timestamptz, '{}'::jsonb)`,
    [
      opts.tenant,
      opts.sessionId,
      opts.storeId,
      opts.receiptId,
      opts.sourceTool ?? 'codex',
      opts.sourceSessionId ?? opts.sessionId,
      opts.projectId ?? null,
      opts.title ?? null,
      opts.startTs,
      opts.endTs ?? null,
    ],
  )
}

async function seedMessage(
  db: PGlite,
  opts: {
    tenant: string
    storeId: string
    receiptId: string
    sessionId: string
    messageId: string
    ordinal: number
    model?: string | null
  },
) {
  await db.query(
    `INSERT INTO projection_message
       (tenant_id, message_id, store_id, receipt_id, session_id, role, model, ordinal, payload)
     VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, '{}'::jsonb)`,
    [opts.tenant, opts.messageId, opts.storeId, opts.receiptId, opts.sessionId, opts.model ?? null, opts.ordinal],
  )
}

async function seedToolCall(
  db: PGlite,
  opts: {
    tenant: string
    storeId: string
    receiptId: string
    sessionId: string
    toolCallId: string
    toolName: string
    canonicalToolType?: string | null
    status?: string | null
  },
) {
  await db.query(
    `INSERT INTO projection_tool_call
       (tenant_id, tool_call_id, store_id, receipt_id, session_id, tool_name, canonical_tool_type, status, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)`,
    [
      opts.tenant,
      opts.toolCallId,
      opts.storeId,
      opts.receiptId,
      opts.sessionId,
      opts.toolName,
      opts.canonicalToolType ?? null,
      opts.status ?? null,
    ],
  )
}

async function seedToolResult(
  db: PGlite,
  opts: {
    tenant: string
    storeId: string
    receiptId: string
    sessionId: string
    toolCallId: string
    toolResultId: string
    isError: boolean
  },
) {
  await db.query(
    `INSERT INTO projection_tool_result
       (tenant_id, tool_result_id, store_id, receipt_id, tool_call_id, session_id, is_error, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)`,
    [opts.tenant, opts.toolResultId, opts.storeId, opts.receiptId, opts.toolCallId, opts.sessionId, opts.isError],
  )
}

async function seedArtifact(
  db: PGlite,
  opts: { tenant: string; storeId: string; receiptId: string; artifactId: string; sessionId: string | null },
) {
  await db.query(
    `INSERT INTO projection_artifact
       (tenant_id, artifact_id, store_id, receipt_id, session_id, source_tool, kind, payload)
     VALUES ($1, $2, $3, $4, $5, 'codex', 'text', '{}'::jsonb)`,
    [opts.tenant, opts.artifactId, opts.storeId, opts.receiptId, opts.sessionId],
  )
}

async function seedSearchDoc(
  db: PGlite,
  opts: { tenant: string; storeId: string; receiptId: string; docId: string; text: string },
) {
  await db.query(
    `INSERT INTO search_doc
       (tenant_id, doc_id, store_id, receipt_id, entity_type, entity_id, field_kind, text, text_tsv)
     VALUES ($1, $2, $3, $4, 'message', $2, 'message_text', $5, to_tsvector('english', $5))`,
    [opts.tenant, opts.docId, opts.storeId, opts.receiptId, opts.text],
  )
}

async function seedFixture(db: PGlite): Promise<void> {
  // Two stores under the tenant; one logical session (`src_shared`)
  // promoted by both stores so the cross-store distinct collapses
  // it to one row.
  await seedAuthority(db, tenantId, 's_a', 'rcp_a')
  await seedAuthority(db, tenantId, 's_b', 'rcp_b')
  await seedAuthority(db, otherTenant, 's_x', 'rcp_x')

  // Sessions under current authority (visible).
  await seedSession(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a1',
    sourceTool: 'codex',
    sourceSessionId: 'src_a1',
    projectId: 'prj_alpha',
    startTs: '2026-05-19T10:00:00Z',
    endTs: '2026-05-19T10:05:00Z',
  })
  await seedSession(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a2',
    sourceTool: 'claude',
    sourceSessionId: 'src_a2',
    projectId: 'prj_beta',
    startTs: '2026-05-20T10:00:00Z',
    endTs: '2026-05-20T10:02:00Z',
  })
  // Cross-store duplicate of `src_shared`: store_a has the older
  // promotion, store_b has the fresher one. DISTINCT ON must keep
  // exactly one row across the analytics path.
  await seedSession(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_shared_old',
    sourceTool: 'codex',
    sourceSessionId: 'src_shared',
    projectId: 'prj_alpha',
    startTs: '2026-05-15T10:00:00Z',
    endTs: '2026-05-15T10:30:00Z',
  })
  await seedSession(db, {
    tenant: tenantId,
    storeId: 's_b',
    receiptId: 'rcp_b',
    sessionId: 'ses_shared_new',
    sourceTool: 'codex',
    sourceSessionId: 'src_shared',
    projectId: 'prj_alpha',
    startTs: '2026-05-19T11:00:00Z',
    endTs: '2026-05-19T12:00:00Z',
  })

  // Superseded session — must not show up anywhere.
  await seedSession(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_superseded',
    sessionId: 'ses_hidden',
    sourceTool: 'codex',
    sourceSessionId: 'src_hidden',
    projectId: 'prj_alpha',
    startTs: '2026-05-19T13:00:00Z',
  })
  // Other-tenant session — must not show up under tenantId.
  await seedSession(db, {
    tenant: otherTenant,
    storeId: 's_x',
    receiptId: 'rcp_x',
    sessionId: 'ses_other',
    sourceTool: 'codex',
    sourceSessionId: 'src_other',
    projectId: 'prj_other',
    startTs: '2026-05-19T10:00:00Z',
  })

  // Messages tied to gate-aware sessions.
  await seedMessage(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a1',
    messageId: 'msg_a1_0',
    ordinal: 0,
    model: 'gpt-5',
  })
  await seedMessage(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a1',
    messageId: 'msg_a1_1',
    ordinal: 1,
    model: 'gpt-5',
  })
  await seedMessage(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a2',
    messageId: 'msg_a2_0',
    ordinal: 0,
    model: 'claude-4',
  })
  // Superseded message - must not count.
  await seedMessage(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_superseded',
    sessionId: 'ses_a1',
    messageId: 'msg_hidden',
    ordinal: 99,
    model: 'should-not-appear',
  })

  // Tool calls + results.
  await seedToolCall(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a1',
    toolCallId: 'tc_a1_bash_ok',
    toolName: 'bash',
    canonicalToolType: 'execute_shell',
    status: 'success',
  })
  await seedToolCall(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a1',
    toolCallId: 'tc_a1_bash_err',
    toolName: 'bash',
    canonicalToolType: 'execute_shell',
    status: 'failure',
  })
  await seedToolResult(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a1',
    toolCallId: 'tc_a1_bash_err',
    toolResultId: 'tr_a1_bash_err',
    isError: true,
  })
  await seedToolCall(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    sessionId: 'ses_a2',
    toolCallId: 'tc_a2_edit',
    toolName: 'edit_file',
    canonicalToolType: 'edit_file',
    status: 'success',
  })

  // Artifacts.
  await seedArtifact(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    artifactId: 'art_a1',
    sessionId: 'ses_a1',
  })
  await seedArtifact(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_superseded',
    artifactId: 'art_hidden',
    sessionId: 'ses_a1',
  })

  // Search docs.
  await seedSearchDoc(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_a',
    docId: 'sd_a1',
    text: 'analytics seed text',
  })
  await seedSearchDoc(db, {
    tenant: tenantId,
    storeId: 's_a',
    receiptId: 'rcp_superseded',
    docId: 'sd_hidden',
    text: 'must not appear',
  })
}

describe('Lane 6 analytics/summary', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    await seedFixture(db)
  })
  afterEach(async () => {
    await db.close()
  })

  it('reports gate-aware + cross-store-collapsed counts (CQ-147)', async () => {
    const out = await getAnalyticsSummary(
      { rawExec: makeRawExec(db), now: () => new Date('2026-05-21T00:00:00Z') },
      tenantId,
    )
    expect(out.generatedAt).toBe('2026-05-21T00:00:00.000Z')
    // 3 LOGICAL sessions after CQ-147 cross-store collapse:
    // src_a1, src_a2, and src_shared (collapsed across s_a + s_b).
    expect(out.counts.sessions).toBe(3)
    // 3 visible messages (gate-aware; ses_shared has no messages).
    expect(out.counts.messages).toBe(3)
    // 3 visible tool calls.
    expect(out.counts.toolCalls).toBe(3)
    // 1 visible tool result with is_error=TRUE.
    expect(out.counts.toolResultErrors).toBe(1)
    // 1 visible artifact (tied to ses_a1 which is in the picked set).
    expect(out.counts.artifacts).toBe(1)
    // 1 visible search doc.
    expect(out.counts.searchDocs).toBe(1)
    // Tenant has authority for 2 stores (s_a, s_b).
    expect(out.counts.stores).toBe(2)
    // 2 distinct sources across picked sessions: codex + claude.
    expect(out.counts.sources).toBe(2)

    const sourceMap = Object.fromEntries(out.sources.map((s) => [s.sourceTool, s.count]))
    // Picked-sessions per tool: codex = {ses_a1, ses_shared_new} = 2,
    // claude = {ses_a2} = 1.
    expect(sourceMap.codex).toBe(2)
    expect(sourceMap.claude).toBe(1)

    const storeMap = Object.fromEntries(out.stores.map((s) => [s.storeId, s.sessionCount]))
    // Picked-sessions per store: s_a = {ses_a1, ses_a2}, s_b =
    // {ses_shared_new}.
    expect(storeMap.s_a).toBe(2)
    expect(storeMap.s_b).toBe(1)
    for (const s of out.stores) {
      expect(s.latestPromotedAt).not.toBeNull()
    }
  })

  it('is tenant scoped: other-tenant rows never contribute', async () => {
    const out = await getAnalyticsSummary(
      { rawExec: makeRawExec(db), now: () => new Date('2026-05-21T00:00:00Z') },
      otherTenant,
    )
    // Other tenant has 1 store / 1 session / 0 messages / 0 tool calls.
    expect(out.counts.sessions).toBe(1)
    expect(out.counts.stores).toBe(1)
    expect(out.counts.messages).toBe(0)
    expect(out.counts.toolCalls).toBe(0)
    expect(out.stores.map((s) => s.storeId)).toEqual(['s_x'])
  })
})

describe('Lane 6 analytics/report — sessions (cross-store distinct)', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    await seedFixture(db)
  })
  afterEach(async () => {
    await db.close()
  })

  it('collapses `src_shared` to a single row keeping the newest end_ts', async () => {
    const out = await getAnalyticsReport(
      { rawExec: makeRawExec(db), now: () => new Date('2026-05-21T00:00:00Z') },
      tenantId,
      { report: 'sessions', limit: 100 },
    )
    expect(out.report).toBe('sessions')
    // One row per logical (source_tool, source_session_id) — 3 logical
    // sessions: src_a1, src_a2, src_shared.
    expect(out.rows.length).toBe(3)
    const shared = out.rows.find((r) => r.source_session_id === 'src_shared')
    if (!shared) throw new Error('expected src_shared row')
    expect(shared.session_id).toBe('ses_shared_new')
    expect(shared.store_id).toBe('s_b')
    expect(shared.receipt_id).toBe('rcp_b')
  })

  it('honours sourceTools filter', async () => {
    const out = await getAnalyticsReport(
      { rawExec: makeRawExec(db), now: () => new Date('2026-05-21T00:00:00Z') },
      tenantId,
      { report: 'sessions', sourceTools: ['claude'], limit: 100 },
    )
    expect(out.rows.length).toBe(1)
    expect(out.rows[0]?.source_session_id).toBe('src_a2')
  })

  it('honours since/until on session start_ts', async () => {
    const since = await getAnalyticsReport(
      { rawExec: makeRawExec(db), now: () => new Date('2026-05-21T00:00:00Z') },
      tenantId,
      { report: 'sessions', since: '2026-05-19T00:00:00Z', limit: 100 },
    )
    expect(since.rows.map((r) => r.source_session_id).sort()).toEqual(['src_a1', 'src_a2', 'src_shared'])
    const until = await getAnalyticsReport(
      { rawExec: makeRawExec(db), now: () => new Date('2026-05-21T00:00:00Z') },
      tenantId,
      { report: 'sessions', until: '2026-05-19T00:00:00Z', limit: 100 },
    )
    expect(until.rows.map((r) => r.source_session_id).sort()).toEqual(['src_shared'])
  })
})

describe('Lane 6 analytics/report — tools / errors / models / projects', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    await seedFixture(db)
  })
  afterEach(async () => {
    await db.close()
  })

  it('tools — aggregates invocations and error counts per tool', async () => {
    const out = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'tools',
      limit: 100,
    })
    const byTool = Object.fromEntries(out.rows.map((r) => [r.tool_name, r]))
    expect(byTool.bash?.invocation_count).toBe(2)
    expect(byTool.bash?.error_count).toBe(1)
    expect(byTool.edit_file?.invocation_count).toBe(1)
    expect(byTool.edit_file?.error_count).toBe(0)
  })

  it('errors — only surfaces tools with at least one error', async () => {
    const out = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'errors',
      limit: 100,
    })
    expect(out.rows.map((r) => r.tool_name)).toEqual(['bash'])
    expect(out.rows[0]?.error_count).toBe(1)
  })

  it('models — buckets messages by model and excludes superseded rows', async () => {
    const out = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'models',
      limit: 100,
    })
    const byModel = Object.fromEntries(out.rows.map((r) => [r.model, r.message_count]))
    expect(byModel['gpt-5']).toBe(2)
    expect(byModel['claude-4']).toBe(1)
    expect(byModel['should-not-appear']).toBeUndefined()
  })

  it('projects — groups by project_id after the cross-store distinct collapse', async () => {
    const out = await getAnalyticsReport({ rawExec: makeRawExec(db), now: () => new Date() }, tenantId, {
      report: 'projects',
      limit: 100,
    })
    const byProject = Object.fromEntries(out.rows.map((r) => [r.project_id, r.session_count]))
    // src_shared collapsed once → prj_alpha sees 2 logical sessions (ses_a1 + shared).
    expect(byProject.prj_alpha).toBe(2)
    expect(byProject.prj_beta).toBe(1)
  })
})
