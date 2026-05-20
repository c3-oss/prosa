// Lane 6 — sessions/transcript pin.
//
// Exercises the multi-pass transcript handler against a fresh v2-only
// PGlite: the receipt-pinned page must include only verified rows,
// the cursor `(ord, message_id)` is stable across pages, bodies past
// the 8 KiB inline budget are reported as `objectId` rather than
// `textInline`, and tool calls / latest results are attached only
// once per turn.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INLINE_TEXT_BUDGET_BYTES, getTranscriptPage } from '../../../src/v2/reads/sessions/transcript.js'

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

async function seedSession(
  db: PGlite,
  s: { tenantId: string; storeId: string; receiptId: string; sessionId: string; title?: string },
) {
  await db.query(
    `INSERT INTO projection_session
       (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
        parent_resolution, timeline_confidence, title, start_ts, end_ts, payload)
     VALUES ($1, $2, $3, $4, 'codex', 'src', 'unresolved', 'high', $5,
             '2026-05-19T10:00:00Z'::timestamptz, '2026-05-19T11:00:00Z'::timestamptz, '{}'::jsonb)`,
    [s.tenantId, s.sessionId, s.storeId, s.receiptId, s.title ?? 'transcript-session'],
  )
}

async function seedMessage(
  db: PGlite,
  m: {
    tenantId: string
    storeId: string
    receiptId: string
    sessionId: string
    messageId: string
    turnId?: string | null
    ordinal: number
    timestamp?: string
    role?: string
    model?: string | null
  },
) {
  await db.query(
    `INSERT INTO projection_message
       (tenant_id, message_id, store_id, receipt_id, session_id, turn_id, role, model, timestamp, ordinal, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, '{}'::jsonb)`,
    [
      m.tenantId,
      m.messageId,
      m.storeId,
      m.receiptId,
      m.sessionId,
      m.turnId ?? null,
      m.role ?? 'assistant',
      m.model ?? 'claude-4',
      m.timestamp ?? `2026-05-19T10:${String(m.ordinal).padStart(2, '0')}:00Z`,
      m.ordinal,
    ],
  )
}

async function seedBlock(
  db: PGlite,
  b: {
    tenantId: string
    storeId: string
    receiptId: string
    sessionId: string
    messageId: string
    blockId: string
    ordinal: number
    textInline?: string | null
    objectId?: string | null
    blockType?: string
    visibility?: string
    isError?: boolean
    isRedacted?: boolean
  },
) {
  await db.query(
    `INSERT INTO projection_content_block
       (tenant_id, block_id, store_id, receipt_id, message_id, session_id, ordinal, block_type,
        is_error, is_redacted, visibility, text_inline, object_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '{}'::jsonb)`,
    [
      b.tenantId,
      b.blockId,
      b.storeId,
      b.receiptId,
      b.messageId,
      b.sessionId,
      b.ordinal,
      b.blockType ?? 'text',
      b.isError ?? false,
      b.isRedacted ?? false,
      b.visibility ?? 'visible',
      b.textInline ?? null,
      b.objectId ?? null,
    ],
  )
}

async function seedToolCall(
  db: PGlite,
  c: {
    tenantId: string
    storeId: string
    receiptId: string
    sessionId: string
    toolCallId: string
    turnId: string | null
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
      c.turnId,
      c.toolName,
      c.canonicalToolType ?? null,
      c.timestampStart ?? '2026-05-19T10:30:00Z',
      c.status ?? null,
    ],
  )
}

async function seedToolResult(
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

describe('Lane 6 sessions/transcript', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns null when the session is not visible under current authority', async () => {
    const r = await getTranscriptPage({ rawExec: makeRawExec(db) }, 't_a', { sessionId: 'ses_missing', limit: 10 })
    expect(r).toBeNull()
  })

  it('returns null when only a superseded receipt exists', async () => {
    await seedAuthority(db, [{ tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_current' }])
    await seedSession(db, {
      tenantId: 't_a',
      storeId: 's_a',
      receiptId: 'rcp_superseded',
      sessionId: 'ses_old',
    })
    const r = await getTranscriptPage({ rawExec: makeRawExec(db) }, 't_a', { sessionId: 'ses_old', limit: 10 })
    expect(r).toBeNull()
  })

  it('paginates messages by derived (ord, message_id) cursor', async () => {
    const tenantId = 't_a'
    const storeId = 's_a'
    const receiptId = 'rcp_a'
    await seedAuthority(db, [{ tenantId, storeId, receiptId }])
    await seedSession(db, { tenantId, storeId, receiptId, sessionId: 'ses_p' })
    for (let i = 0; i < 5; i += 1) {
      await seedMessage(db, {
        tenantId,
        storeId,
        receiptId,
        sessionId: 'ses_p',
        messageId: `msg_${String(i).padStart(2, '0')}`,
        turnId: `turn_${i}`,
        ordinal: i,
        timestamp: `2026-05-19T10:${String(i).padStart(2, '0')}:00Z`,
      })
    }
    const page1 = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
      sessionId: 'ses_p',
      limit: 2,
    })
    if (!page1) throw new Error('expected page')
    expect(page1.turns.map((t) => t.messageId)).toEqual(['msg_00', 'msg_01'])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
      sessionId: 'ses_p',
      limit: 2,
      cursor: page1.nextCursor,
    })
    if (!page2) throw new Error('expected page')
    expect(page2.turns.map((t) => t.messageId)).toEqual(['msg_02', 'msg_03'])
    expect(page2.nextCursor).not.toBeNull()
    const page3 = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
      sessionId: 'ses_p',
      limit: 2,
      cursor: page2.nextCursor,
    })
    if (!page3) throw new Error('expected page')
    expect(page3.turns.map((t) => t.messageId)).toEqual(['msg_04'])
    expect(page3.nextCursor).toBeNull()
  })

  it('omits bodies past the 8 KiB inline budget but keeps the object id', async () => {
    const tenantId = 't_a'
    const storeId = 's_a'
    const receiptId = 'rcp_a'
    await seedAuthority(db, [{ tenantId, storeId, receiptId }])
    await seedSession(db, { tenantId, storeId, receiptId, sessionId: 'ses_b' })
    await seedMessage(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_b',
      messageId: 'msg_b',
      ordinal: 0,
    })
    const small = 'hello world'
    const large = 'x'.repeat(INLINE_TEXT_BUDGET_BYTES + 1)
    await seedBlock(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_b',
      messageId: 'msg_b',
      blockId: 'blk_small',
      ordinal: 0,
      textInline: small,
    })
    await seedBlock(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_b',
      messageId: 'msg_b',
      blockId: 'blk_large',
      ordinal: 1,
      textInline: large,
      objectId: 'obj_large_body',
    })
    const r = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
      sessionId: 'ses_b',
      limit: 10,
    })
    if (!r) throw new Error('expected page')
    const blocks = r.turns[0]?.blocks ?? []
    expect(blocks.map((b) => b.blockId)).toEqual(['blk_small', 'blk_large'])
    const smallBlock = blocks.find((b) => b.blockId === 'blk_small')
    const largeBlock = blocks.find((b) => b.blockId === 'blk_large')
    expect(smallBlock?.textInline).toBe(small)
    expect(largeBlock?.textInline).toBeNull()
    expect(largeBlock?.textObjectId).toBe('obj_large_body')
  })

  it('attaches tool calls + latest result to their first turn and surfaces unattached calls once', async () => {
    const tenantId = 't_a'
    const storeId = 's_a'
    const receiptId = 'rcp_a'
    await seedAuthority(db, [{ tenantId, storeId, receiptId }])
    await seedSession(db, { tenantId, storeId, receiptId, sessionId: 'ses_t' })
    await seedMessage(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_t',
      messageId: 'msg_1',
      turnId: 'turn_1',
      ordinal: 0,
    })
    // Second message on the same turn — within a single page, tool
    // calls must not repeat. Across pages the slim remote schema
    // forces the renderer to dedupe on its side because tool_call
    // rows are not attributed to a specific message id.
    await seedMessage(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_t',
      messageId: 'msg_1b_same_turn',
      turnId: 'turn_1',
      ordinal: 1,
    })
    await seedMessage(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_t',
      messageId: 'msg_2',
      turnId: 'turn_2',
      ordinal: 2,
    })
    await seedToolCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_t',
      toolCallId: 'tc_attached',
      turnId: 'turn_1',
      toolName: 'bash',
      canonicalToolType: 'execute_shell',
    })
    await seedToolResult(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_t',
      toolCallId: 'tc_attached',
      toolResultId: 'tr_attached',
      status: 'success',
      isError: false,
      durationMs: 100,
    })
    // Two results for the same call — only the latest (highest id) must win.
    await seedToolResult(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_t',
      toolCallId: 'tc_attached',
      toolResultId: 'tr_attached_z',
      status: 'failure',
      isError: true,
      durationMs: 200,
    })
    await seedToolCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_t',
      toolCallId: 'tc_orphan',
      turnId: null,
      toolName: 'read_file',
    })

    // Limit=2 keeps the same-turn pair on the first page (proves
    // within-page dedup). Limit again to a second page so we can
    // prove `unattachedToolCalls` only surfaces on the first page.
    const first = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
      sessionId: 'ses_t',
      limit: 2,
    })
    if (!first) throw new Error('expected page')
    expect(first.turns.map((t) => t.messageId)).toEqual(['msg_1', 'msg_1b_same_turn'])
    expect(first.turns[0]?.toolCalls.map((c) => c.toolCallId)).toEqual(['tc_attached'])
    // Within-page: same-turn sibling must NOT repeat the calls.
    expect(first.turns[1]?.toolCalls).toEqual([])
    const attachedResult = first.turns[0]?.toolCalls[0]?.result
    expect(attachedResult?.toolResultId).toBe('tr_attached_z')
    expect(attachedResult?.isError).toBe(true)
    expect(first.unattachedToolCalls.map((c) => c.toolCallId)).toEqual(['tc_orphan'])
    expect(first.nextCursor).not.toBeNull()

    const second = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
      sessionId: 'ses_t',
      limit: 2,
      cursor: first.nextCursor,
    })
    if (!second) throw new Error('expected page')
    expect(second.turns.map((t) => t.messageId)).toEqual(['msg_2'])
    // Unattached calls must NOT re-emit on a non-first page.
    expect(second.unattachedToolCalls).toEqual([])
  })

  it('hides projections from a superseded receipt across messages / blocks / calls', async () => {
    const tenantId = 't_a'
    const storeId = 's_a'
    const receiptId = 'rcp_current'
    const stale = 'rcp_superseded'
    await seedAuthority(db, [{ tenantId, storeId, receiptId }])
    await seedSession(db, { tenantId, storeId, receiptId, sessionId: 'ses_h' })
    await seedMessage(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_h',
      messageId: 'msg_current',
      turnId: 'turn_h',
      ordinal: 0,
    })
    // Superseded message — must not appear.
    await seedMessage(db, {
      tenantId,
      storeId,
      receiptId: stale,
      sessionId: 'ses_h',
      messageId: 'msg_super',
      turnId: 'turn_h',
      ordinal: 1,
    })
    // Superseded block on the current message — must drop.
    await seedBlock(db, {
      tenantId,
      storeId,
      receiptId: stale,
      sessionId: 'ses_h',
      messageId: 'msg_current',
      blockId: 'blk_super',
      ordinal: 0,
      textInline: 'do not surface',
    })
    // Current block.
    await seedBlock(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_h',
      messageId: 'msg_current',
      blockId: 'blk_current',
      ordinal: 1,
      textInline: 'visible',
    })
    // Superseded tool call.
    await seedToolCall(db, {
      tenantId,
      storeId,
      receiptId: stale,
      sessionId: 'ses_h',
      toolCallId: 'tc_super',
      turnId: 'turn_h',
      toolName: 'bash',
    })
    // Current tool call.
    await seedToolCall(db, {
      tenantId,
      storeId,
      receiptId,
      sessionId: 'ses_h',
      toolCallId: 'tc_current',
      turnId: 'turn_h',
      toolName: 'bash',
    })

    const r = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, { sessionId: 'ses_h', limit: 10 })
    if (!r) throw new Error('expected page')
    expect(r.turns.map((t) => t.messageId)).toEqual(['msg_current'])
    expect(r.turns[0]?.blocks.map((b) => b.blockId)).toEqual(['blk_current'])
    expect(r.turns[0]?.toolCalls.map((c) => c.toolCallId)).toEqual(['tc_current'])
  })
})
