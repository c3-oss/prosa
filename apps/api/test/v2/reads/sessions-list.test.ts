// Lane 6 — sessions/list + sessions/count + sessions/detail pin.
//
// Drives the handler functions directly against a fresh v2-only
// PGlite so cursor stability, filter combinations, cross-store
// conflict resolution, and the verified-projection gate are all
// exercised without the HTTP / Better Auth round-trip. The HTTP
// gate ladder (401 / 403) is pinned by the authority-refresh test
// for the shared `requireV2Tenant` helper; the same helper guards
// every route registered in `registerV2ReadRoutes`.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countSessions } from '../../../src/v2/reads/sessions/count.js'
import { getSessionDetail } from '../../../src/v2/reads/sessions/detail.js'
import { listSessions } from '../../../src/v2/reads/sessions/list.js'
import { createInProcessCursorSigner } from '../../../src/v2/reads/shared/cursor-signer.js'

type Seed = {
  tenantId: string
  storeId: string
  receiptId: string
  sessionId: string
  sourceTool: string
  sourceSessionId: string
  startTs: string | null
  endTs?: string | null
  title?: string
  projectId?: string | null
  isSubagent?: boolean
  parentSessionId?: string | null
  status?: string | null
  summary?: string | null
}

const cursorSigner = createInProcessCursorSigner()

function makeRawExec(db: PGlite) {
  return async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await db.query<Row>(sql, params)
    return res.rows
  }
}

async function seedAuthority(
  db: PGlite,
  rows: Array<{ tenantId: string; storeId: string; receiptId: string }>,
): Promise<void> {
  for (const r of rows) {
    await db.query(
      `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, store_id) DO UPDATE SET current_receipt_id = EXCLUDED.current_receipt_id`,
      [r.tenantId, r.storeId, r.receiptId, 'aa'.repeat(16)],
    )
  }
}

async function seedSession(db: PGlite, s: Seed): Promise<void> {
  await db.query(
    `INSERT INTO projection_session
       (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
        project_id, parent_session_id, parent_resolution, is_subagent, title, summary,
        start_ts, end_ts, status, timeline_confidence, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unresolved', $9, $10, $11, $12::timestamptz, $13::timestamptz,
             $14, 'high', '{}'::jsonb)`,
    [
      s.tenantId,
      s.sessionId,
      s.storeId,
      s.receiptId,
      s.sourceTool,
      s.sourceSessionId,
      s.projectId ?? null,
      s.parentSessionId ?? null,
      s.isSubagent ?? false,
      s.title ?? null,
      s.summary ?? null,
      s.startTs,
      s.endTs ?? null,
      s.status ?? null,
    ],
  )
}

async function seedMessage(
  db: PGlite,
  opts: { tenantId: string; storeId: string; receiptId: string; sessionId: string; messageId: string; ordinal: number },
) {
  await db.query(
    `INSERT INTO projection_message
       (tenant_id, message_id, store_id, receipt_id, session_id, role, ordinal, payload)
     VALUES ($1, $2, $3, $4, $5, 'user', $6, '{}'::jsonb)`,
    [opts.tenantId, opts.messageId, opts.storeId, opts.receiptId, opts.sessionId, opts.ordinal],
  )
}

async function seedToolCall(
  db: PGlite,
  opts: {
    tenantId: string
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
      opts.tenantId,
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

describe('Lane 6 sessions/list — pagination + filters', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns an empty page for a tenant with no authority', async () => {
    const result = await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_empty', { limit: 50 })
    expect(result.rows).toEqual([])
    expect(result.nextCursor).toBeNull()
  })

  it('hides projection rows whose receipt is not the current authority', async () => {
    await seedAuthority(db, [{ tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_current' }])
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_a',
      receiptId: 'rcp_current',
      sessionId: 'ses_visible',
      sourceTool: 'codex',
      sourceSessionId: 'src_1',
      startTs: '2026-05-19T12:00:00Z',
      endTs: '2026-05-19T12:10:00Z',
      title: 'visible',
    })
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_a',
      receiptId: 'rcp_superseded',
      sessionId: 'ses_hidden',
      sourceTool: 'codex',
      sourceSessionId: 'src_2',
      startTs: '2026-05-19T11:00:00Z',
      title: 'should-not-leak',
    })

    const result = await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', { limit: 50 })
    expect(result.rows.map((r) => r.id)).toEqual(['ses_visible'])
  })

  it('orders by start_ts DESC, session_id DESC and paginates with a stable cursor', async () => {
    await seedAuthority(db, [{ tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_a' }])
    for (let i = 0; i < 6; i += 1) {
      const start = new Date(2026, 4, 20, 10, i).toISOString()
      await seedSession(db, {
        tenantId: 't_a',
        storeId: 's_a',
        receiptId: 'rcp_a',
        sessionId: `ses_${String(i).padStart(2, '0')}`,
        sourceTool: 'codex',
        sourceSessionId: `src_${i}`,
        startTs: start,
        endTs: start,
        title: `t-${i}`,
      })
    }
    const page1 = await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', { limit: 3 })
    expect(page1.rows.map((r) => r.id)).toEqual(['ses_05', 'ses_04', 'ses_03'])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', {
      limit: 3,
      cursor: page1.nextCursor,
    })
    expect(page2.rows.map((r) => r.id)).toEqual(['ses_02', 'ses_01', 'ses_00'])
    expect(page2.nextCursor).toBeNull()
  })

  it('collapses cross-store duplicates of the same logical session', async () => {
    await seedAuthority(db, [
      { tenantId: 't_a', storeId: 's_old', receiptId: 'rcp_old' },
      { tenantId: 't_a', storeId: 's_new', receiptId: 'rcp_new' },
    ])
    // Same (source_tool, source_session_id) tuple promoted by two
    // stores. The newest end_ts must win and the page must return
    // exactly one row.
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_old',
      receiptId: 'rcp_old',
      sessionId: 'ses_old_copy',
      sourceTool: 'codex',
      sourceSessionId: 'src_shared',
      startTs: '2026-05-15T10:00:00Z',
      endTs: '2026-05-15T10:30:00Z',
      title: 'old-copy',
    })
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_new',
      receiptId: 'rcp_new',
      sessionId: 'ses_new_copy',
      sourceTool: 'codex',
      sourceSessionId: 'src_shared',
      startTs: '2026-05-19T10:00:00Z',
      endTs: '2026-05-19T11:00:00Z',
      title: 'new-copy',
    })
    const result = await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', { limit: 10 })
    expect(result.rows.length).toBe(1)
    expect(result.rows[0]?.id).toBe('ses_new_copy')
    expect(result.rows[0]?.storeId).toBe('s_new')
  })

  it('applies sourceTools / projectIds / storeIds / since / until / q filters', async () => {
    await seedAuthority(db, [
      { tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_a' },
      { tenantId: 't_a', storeId: 's_b', receiptId: 'rcp_b' },
    ])
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_a',
      receiptId: 'rcp_a',
      sessionId: 'ses_codex',
      sourceTool: 'codex',
      sourceSessionId: 'src_codex',
      startTs: '2026-05-19T10:00:00Z',
      title: 'fox jumps',
      projectId: 'prj_x',
    })
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_b',
      receiptId: 'rcp_b',
      sessionId: 'ses_claude',
      sourceTool: 'claude',
      sourceSessionId: 'src_claude',
      startTs: '2026-05-21T10:00:00Z',
      title: 'lazy dog',
      projectId: 'prj_y',
    })

    expect(
      (
        await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', { limit: 10, sourceTools: ['codex'] })
      ).rows.map((r) => r.id),
    ).toEqual(['ses_codex'])
    expect(
      (
        await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', { limit: 10, projectIds: ['prj_y'] })
      ).rows.map((r) => r.id),
    ).toEqual(['ses_claude'])
    expect(
      (
        await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', { limit: 10, storeIds: ['s_b'] })
      ).rows.map((r) => r.id),
    ).toEqual(['ses_claude'])
    expect(
      (await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', { limit: 10, q: 'fox' })).rows.map(
        (r) => r.id,
      ),
    ).toEqual(['ses_codex'])
    expect(
      (
        await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', {
          limit: 10,
          since: '2026-05-20T00:00:00Z',
        })
      ).rows.map((r) => r.id),
    ).toEqual(['ses_claude'])
    expect(
      (
        await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_a', {
          limit: 10,
          until: '2026-05-20T00:00:00Z',
        })
      ).rows.map((r) => r.id),
    ).toEqual(['ses_codex'])
  })

  it('is tenant scoped: another tenants rows never appear', async () => {
    await seedAuthority(db, [
      { tenantId: 't_alice', storeId: 's_a', receiptId: 'rcp_alice' },
      { tenantId: 't_bob', storeId: 's_a', receiptId: 'rcp_bob' },
    ])
    await seedSession(db, {
      tenantId: 't_alice',
      storeId: 's_a',
      receiptId: 'rcp_alice',
      sessionId: 'ses_alice',
      sourceTool: 'codex',
      sourceSessionId: 'src_alice',
      startTs: '2026-05-19T10:00:00Z',
      title: 'alice-only',
    })
    await seedSession(db, {
      tenantId: 't_bob',
      storeId: 's_a',
      receiptId: 'rcp_bob',
      sessionId: 'ses_bob',
      sourceTool: 'codex',
      sourceSessionId: 'src_bob',
      startTs: '2026-05-19T10:00:00Z',
      title: 'bob-only',
    })
    const alice = await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_alice', { limit: 10 })
    expect(alice.rows.map((r) => r.id)).toEqual(['ses_alice'])
    const bob = await listSessions({ rawExec: makeRawExec(db), cursorSigner }, 't_bob', { limit: 10 })
    expect(bob.rows.map((r) => r.id)).toEqual(['ses_bob'])
  })
})

describe('Lane 6 sessions/count — collapsed receipt-pinned count', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  it('counts logical sessions once even when promoted by multiple stores', async () => {
    await seedAuthority(db, [
      { tenantId: 't_a', storeId: 's_old', receiptId: 'rcp_old' },
      { tenantId: 't_a', storeId: 's_new', receiptId: 'rcp_new' },
    ])
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_old',
      receiptId: 'rcp_old',
      sessionId: 'ses_old',
      sourceTool: 'codex',
      sourceSessionId: 'src_shared',
      startTs: '2026-05-15T10:00:00Z',
    })
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_new',
      receiptId: 'rcp_new',
      sessionId: 'ses_new',
      sourceTool: 'codex',
      sourceSessionId: 'src_shared',
      startTs: '2026-05-19T10:00:00Z',
    })
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_new',
      receiptId: 'rcp_new',
      sessionId: 'ses_unique',
      sourceTool: 'claude',
      sourceSessionId: 'src_unique',
      startTs: '2026-05-20T10:00:00Z',
    })
    expect(await countSessions({ rawExec: makeRawExec(db) }, 't_a', {})).toEqual({ count: 2 })
    expect(await countSessions({ rawExec: makeRawExec(db) }, 't_a', { sourceTools: ['codex'] })).toEqual({ count: 1 })
    expect(await countSessions({ rawExec: makeRawExec(db) }, 't_a', { sourceTools: ['hermes'] })).toEqual({ count: 0 })
  })
})

describe('Lane 6 sessions/detail — header + receipt-pinned counts', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns found: false when the session id does not exist or is not current', async () => {
    await seedAuthority(db, [{ tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_a' }])
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_a',
      receiptId: 'rcp_superseded',
      sessionId: 'ses_hidden',
      sourceTool: 'codex',
      sourceSessionId: 'src_hidden',
      startTs: null,
    })
    const noRow = await getSessionDetail({ rawExec: makeRawExec(db) }, 't_a', { sessionId: 'ses_missing' })
    expect(noRow.found).toBe(false)
    const supersededRow = await getSessionDetail({ rawExec: makeRawExec(db) }, 't_a', { sessionId: 'ses_hidden' })
    expect(supersededRow.found).toBe(false)
  })

  it('returns the header and gate-aware counts for a current session', async () => {
    await seedAuthority(db, [{ tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_a' }])
    const common = { tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_a', sessionId: 'ses_detail' }
    await seedSession(db, {
      ...common,
      sourceTool: 'codex',
      sourceSessionId: 'src_detail',
      startTs: '2026-05-19T10:00:00Z',
      endTs: '2026-05-19T10:30:00Z',
      title: 'detail-test',
    })
    await seedMessage(db, { ...common, messageId: 'msg_1', ordinal: 0 })
    await seedMessage(db, { ...common, messageId: 'msg_2', ordinal: 1 })
    await seedToolCall(db, {
      ...common,
      toolCallId: 'tc_ok',
      toolName: 'bash',
      canonicalToolType: 'execute_shell',
      status: 'success',
    })
    // Tool call with an error result.
    await seedToolCall(db, { ...common, toolCallId: 'tc_err', toolName: 'bash', status: 'failure' })
    await db.query(
      `INSERT INTO projection_tool_result
         (tenant_id, tool_result_id, store_id, receipt_id, tool_call_id, session_id, status, is_error, payload)
       VALUES ($1, 'tr_err', $2, $3, 'tc_err', $4, 'failure', TRUE, '{}'::jsonb)`,
      [common.tenantId, common.storeId, common.receiptId, common.sessionId],
    )
    // Superseded message shouldn't be counted.
    await db.query(
      `INSERT INTO projection_message
         (tenant_id, message_id, store_id, receipt_id, session_id, role, ordinal, payload)
       VALUES ($1, 'msg_super', $2, 'rcp_old', $3, 'user', 99, '{}'::jsonb)`,
      [common.tenantId, common.storeId, common.sessionId],
    )

    const detail = await getSessionDetail({ rawExec: makeRawExec(db) }, 't_a', { sessionId: 'ses_detail' })
    expect(detail.found).toBe(true)
    if (!detail.found) throw new Error('unreachable')
    expect(detail.session.id).toBe('ses_detail')
    expect(detail.session.title).toBe('detail-test')
    expect(detail.counts.messages).toBe(2)
    expect(detail.counts.toolCalls).toBe(2)
    expect(detail.counts.toolResultErrors).toBe(1)
    expect(detail.auxiliaryRowsAvailable).toBe(true)
  })
})
