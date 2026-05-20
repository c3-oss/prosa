// Lane 6 — tool-calls/list pin.
//
// Drives `listToolCalls` against a fresh v2-only PGlite. Asserts the
// verified-projection gate hides superseded calls, every documented
// filter narrows correctly, the LATERAL join picks the latest tool
// result, and the `(timestamp_start, tool_call_id)` cursor is
// stable across pages.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInProcessCursorSigner } from '../../../src/v2/reads/shared/cursor-signer.js'
import { listToolCalls } from '../../../src/v2/reads/tool-calls/list.js'

const cursorSigner = createInProcessCursorSigner()

function makeRawExec(db: PGlite) {
  return async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await db.query<Row>(sql, params)
    return res.rows
  }
}

async function seedAuthority(db: PGlite, rows: Array<{ tenantId: string; storeId: string; receiptId: string }>) {
  for (const r of rows) {
    await db.query(
      `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, store_id) DO UPDATE SET current_receipt_id = EXCLUDED.current_receipt_id`,
      [r.tenantId, r.storeId, r.receiptId, 'aa'.repeat(16)],
    )
  }
}

async function seedCall(
  db: PGlite,
  c: {
    tenantId: string
    storeId: string
    receiptId: string
    sessionId: string
    toolCallId: string
    turnId?: string | null
    toolName: string
    canonicalToolType?: string | null
    timestampStart?: string | null
    status?: string | null
  },
) {
  await db.query(
    `INSERT INTO projection_tool_call
       (tenant_id, tool_call_id, store_id, receipt_id, session_id, turn_id, tool_name,
        canonical_tool_type, timestamp_start, status, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, '{}'::jsonb)`,
    [
      c.tenantId,
      c.toolCallId,
      c.storeId,
      c.receiptId,
      c.sessionId,
      c.turnId ?? null,
      c.toolName,
      c.canonicalToolType ?? null,
      c.timestampStart ?? null,
      c.status ?? null,
    ],
  )
}

async function seedResult(
  db: PGlite,
  r: {
    tenantId: string
    storeId: string
    receiptId: string
    sessionId: string
    toolCallId: string
    toolResultId: string
    status?: string | null
    isError?: boolean
    exitCode?: number | null
    durationMs?: number | null
  },
) {
  await db.query(
    `INSERT INTO projection_tool_result
       (tenant_id, tool_result_id, store_id, receipt_id, tool_call_id, session_id, status,
        is_error, exit_code, duration_ms, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb)`,
    [
      r.tenantId,
      r.toolResultId,
      r.storeId,
      r.receiptId,
      r.toolCallId,
      r.sessionId,
      r.status ?? null,
      r.isError ?? false,
      r.exitCode ?? null,
      r.durationMs ?? null,
    ],
  )
}

describe('Lane 6 tool-calls/list', () => {
  let db: PGlite
  const tenantId = 't_a'
  const storeId = 's_a'
  const receiptId = 'rcp_a'
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    await seedAuthority(db, [{ tenantId, storeId, receiptId }])
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns empty rows for a tenant with no projected calls', async () => {
    const r = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { limit: 10 })
    expect(r.rows).toEqual([])
    expect(r.nextCursor).toBeNull()
  })

  it('hides calls whose receipt is not the current authority', async () => {
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_visible',
      toolName: 'bash',
      timestampStart: '2026-05-19T10:00:00Z',
    })
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId: 'rcp_superseded',
      sessionId: 'ses_a',
      toolCallId: 'tc_hidden',
      toolName: 'bash',
      timestampStart: '2026-05-19T11:00:00Z',
    })
    const r = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { limit: 10 })
    expect(r.rows.map((row) => row.toolCallId)).toEqual(['tc_visible'])
  })

  it('joins to the latest tool result via LATERAL', async () => {
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_one',
      toolName: 'bash',
      timestampStart: '2026-05-19T10:00:00Z',
      status: 'failure',
    })
    // Result ids are lexically ordered so the LATERAL join's
    // `ORDER BY tool_result_id DESC` deterministically picks the
    // newest. (`projection_tool_result` has no timestamp column;
    // monotonic ids are the documented invariant.)
    await seedResult(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_one',
      toolResultId: 'tr_a_old',
      status: 'success',
      isError: false,
    })
    await seedResult(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_one',
      toolResultId: 'tr_b_new',
      status: 'failure',
      isError: true,
      exitCode: 2,
      durationMs: 1234,
    })
    const r = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { limit: 10 })
    expect(r.rows.map((row) => row.toolCallId)).toEqual(['tc_one'])
    expect(r.rows[0]?.latestResult).toMatchObject({
      toolResultId: 'tr_b_new',
      isError: true,
      exitCode: 2,
      durationMs: 1234,
    })
  })

  it('filters by sessionId / toolNames / canonicalToolTypes / since / until', async () => {
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_a',
      toolName: 'bash',
      canonicalToolType: 'execute_shell',
      timestampStart: '2026-05-19T10:00:00Z',
    })
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_b',
      toolCallId: 'tc_b',
      toolName: 'edit_file',
      canonicalToolType: 'edit_file',
      timestampStart: '2026-05-21T10:00:00Z',
    })
    expect(
      (
        await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { sessionId: 'ses_a', limit: 10 })
      ).rows.map((r) => r.toolCallId),
    ).toEqual(['tc_a'])
    expect(
      (
        await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, {
          toolNames: ['edit_file'],
          limit: 10,
        })
      ).rows.map((r) => r.toolCallId),
    ).toEqual(['tc_b'])
    expect(
      (
        await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, {
          canonicalToolTypes: ['execute_shell'],
          limit: 10,
        })
      ).rows.map((r) => r.toolCallId),
    ).toEqual(['tc_a'])
    expect(
      (
        await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, {
          since: '2026-05-20T00:00:00Z',
          limit: 10,
        })
      ).rows.map((r) => r.toolCallId),
    ).toEqual(['tc_b'])
    expect(
      (
        await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, {
          until: '2026-05-20T00:00:00Z',
          limit: 10,
        })
      ).rows.map((r) => r.toolCallId),
    ).toEqual(['tc_a'])
  })

  it('filters by errorsOnly (status string OR latest result is_error)', async () => {
    // Call with status='failure' on the call row itself.
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_status_err',
      toolName: 'bash',
      status: 'failure',
      timestampStart: '2026-05-19T10:00:00Z',
    })
    // Call with a result.is_error flag.
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_result_err',
      toolName: 'bash',
      timestampStart: '2026-05-19T11:00:00Z',
    })
    await seedResult(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_result_err',
      toolResultId: 'tr_result_err',
      status: 'failure',
      isError: true,
    })
    // Healthy call — must not appear under errorsOnly.
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_ok',
      toolName: 'bash',
      status: 'success',
      timestampStart: '2026-05-19T12:00:00Z',
    })
    await seedResult(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_ok',
      toolResultId: 'tr_ok',
      status: 'success',
      isError: false,
    })
    const r = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { errorsOnly: true, limit: 10 })
    expect(r.rows.map((row) => row.toolCallId).sort()).toEqual(['tc_result_err', 'tc_status_err'])
  })

  it('ignores result rows with mismatched session_id even under current authority (CQ-148)', async () => {
    // Governor smoke regression: a current-authority tool_result that
    // shares store/receipt/tool_call_id with the visible call but has
    // a different session_id must NOT be attached to `latestResult`.
    // The LATERAL join must tuple-match session_id as well.
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_current',
      toolCallId: 'tc_shared',
      toolName: 'bash',
      timestampStart: '2026-05-19T10:00:00Z',
    })
    await seedResult(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_wrong',
      toolCallId: 'tc_shared',
      toolResultId: 'tr_wrong_session',
      status: 'failure',
      isError: true,
    })
    const r = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { limit: 10 })
    expect(r.rows.map((row) => row.toolCallId)).toEqual(['tc_shared'])
    expect(r.rows[0]?.sessionId).toBe('ses_current')
    expect(r.rows[0]?.latestResult).toBeNull()
  })

  it('ignores result rows with mismatched receipt_id even under current authority (CQ-148)', async () => {
    // A `tool_result` that shares store/session/tool_call_id with the
    // visible call but is pinned to a different receipt id must not
    // attach. The result row is invisible to the verified-projection
    // gate already (different receipt id), but the tuple-match also
    // forbids attaching it as `latestResult`.
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_a',
      toolName: 'bash',
      timestampStart: '2026-05-19T10:00:00Z',
    })
    // Promote a second authority briefly so the wrong-receipt result
    // is current-authority on its own (different receipt) — then
    // restore the original authority. The result row stays in
    // projection_tool_result with the superseded receipt.
    await seedResult(db, {
      tenantId,
      storeId,
      receiptId: 'rcp_other',
      sessionId: 'ses_a',
      toolCallId: 'tc_a',
      toolResultId: 'tr_wrong_receipt',
      status: 'failure',
      isError: true,
    })
    const r = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { limit: 10 })
    expect(r.rows.map((row) => row.toolCallId)).toEqual(['tc_a'])
    expect(r.rows[0]?.latestResult).toBeNull()
  })

  it('ignores result rows with mismatched store_id even under current authority (CQ-148)', async () => {
    // Seed a second current authority for a different store on the
    // same tenant. A result row that lives on that other store but
    // shares tool_call_id/session_id/receipt-id placeholder must
    // never attach to a call from store `s_a`.
    await seedAuthority(db, [{ tenantId, storeId: 's_other', receiptId: 'rcp_other' }])
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_a',
      toolCallId: 'tc_a',
      toolName: 'bash',
      timestampStart: '2026-05-19T10:00:00Z',
    })
    await seedResult(db, {
      tenantId,
      storeId: 's_other',
      receiptId: 'rcp_other',
      sessionId: 'ses_a',
      toolCallId: 'tc_a',
      toolResultId: 'tr_wrong_store',
      status: 'failure',
      isError: true,
    })
    const r = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { limit: 10 })
    expect(r.rows.map((row) => row.toolCallId)).toEqual(['tc_a'])
    expect(r.rows[0]?.storeId).toBe(storeId)
    expect(r.rows[0]?.latestResult).toBeNull()
  })

  it('errorsOnly does not match wrong-tuple result rows (CQ-148)', async () => {
    // A healthy call (no own-status error, no own-tuple result) must
    // not be returned under errorsOnly even if a current-authority
    // wrong-session/result row with `is_error=true` exists.
    await seedCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_current',
      toolCallId: 'tc_shared',
      toolName: 'bash',
      status: 'success',
      timestampStart: '2026-05-19T10:00:00Z',
    })
    await seedResult(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_wrong',
      toolCallId: 'tc_shared',
      toolResultId: 'tr_wrong_session',
      status: 'failure',
      isError: true,
    })
    const r = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, {
      errorsOnly: true,
      limit: 10,
    })
    expect(r.rows).toEqual([])
  })

  it('paginates by (timestamp_start, tool_call_id) — DESC, stable across pages', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedCall(db, {
        tenantId,
        storeId,
        receiptId,
        sessionId: 'ses_a',
        toolCallId: `tc_${String(i).padStart(2, '0')}`,
        toolName: 'bash',
        timestampStart: `2026-05-19T10:${String(i).padStart(2, '0')}:00Z`,
      })
    }
    const collected: string[] = []
    let cursor: string | null | undefined
    let safety = 0
    do {
      const page = await listToolCalls({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { limit: 2, cursor })
      for (const r of page.rows) collected.push(r.toolCallId)
      cursor = page.nextCursor
      safety += 1
      if (safety > 10) throw new Error('runaway pagination')
    } while (cursor)
    expect(collected).toEqual(['tc_04', 'tc_03', 'tc_02', 'tc_01', 'tc_00'])
  })
})
