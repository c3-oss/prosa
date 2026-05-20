// Lane 6 / CQ-142 — receipt-snapshot cursor acceptance.
//
// Every paginated v2 read must pin the (store_id, receipt_id) set
// captured at page 1 and re-use it verbatim for subsequent pages.
// A promotion between page 1 and page 2 must NOT change the visible
// row set, must NOT skip a row already counted, must NOT duplicate
// a row, and must NOT mix receipts.
//
// Each scenario:
//   1. seeds a tenant + 1 store + multiple projection rows
//   2. fetches page 1
//   3. flips `remote_authority_v2.current_receipt_id` to a fresh
//      receipt and seeds rows that *would* be visible under the
//      new authority
//   4. fetches page 2 with the cursor; the new rows must NOT
//      appear, the original rows on page 2 must still appear under
//      the original receipt id.
//
// Tampered / malformed cursors fail closed with `InvalidCursorError`.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchQuery } from '../../../src/v2/reads/search/query.js'
import { listSessions } from '../../../src/v2/reads/sessions/list.js'
import { getTranscriptPage } from '../../../src/v2/reads/sessions/transcript.js'
import { InvalidCursorError } from '../../../src/v2/reads/shared/authority-snapshot.js'
import { listToolCalls } from '../../../src/v2/reads/tool-calls/list.js'

function makeRawExec(db: PGlite) {
  return async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await db.query<Row>(sql, params)
    return res.rows
  }
}

async function setAuthority(db: PGlite, tenantId: string, storeId: string, receiptId: string): Promise<void> {
  await db.query(
    `INSERT INTO remote_authority_v2
       (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, store_id) DO UPDATE
       SET current_receipt_id = EXCLUDED.current_receipt_id,
           promoted_at = now()`,
    [tenantId, storeId, receiptId, 'aa'.repeat(16)],
  )
}

const tenantId = 't_a'
const storeId = 's_a'

describe('Lane 6 sessions/list — receipt-snapshot pin under in-flight promotion (CQ-142)', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  async function seedSession(opts: {
    sessionId: string
    receiptId: string
    startTs: string
  }) {
    await db.query(
      `INSERT INTO projection_session
         (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
          parent_resolution, timeline_confidence, title, start_ts, payload)
       VALUES ($1, $2, $3, $4, 'codex', $5, 'unresolved', 'high', $6, $7::timestamptz, '{}'::jsonb)`,
      [tenantId, opts.sessionId, storeId, opts.receiptId, opts.sessionId, opts.sessionId, opts.startTs],
    )
  }

  it('page 2 still sees only rows under the original snapshot after a mid-iteration promotion', async () => {
    await setAuthority(db, tenantId, storeId, 'rcp_v1')
    // Seed 4 rows under v1.
    for (let i = 0; i < 4; i += 1) {
      await seedSession({
        sessionId: `ses_v1_${i}`,
        receiptId: 'rcp_v1',
        startTs: `2026-05-19T10:0${3 - i}:00Z`,
      })
    }
    const page1 = await listSessions({ rawExec: makeRawExec(db) }, tenantId, { limit: 2 })
    // start_ts DESC, session_id DESC
    expect(page1.rows.map((r) => r.id)).toEqual(['ses_v1_0', 'ses_v1_1'])
    expect(page1.nextCursor).not.toBeNull()

    // Flip authority to v2 and seed a fresh row that would be
    // visible under v2 if the gate re-resolved.
    await setAuthority(db, tenantId, storeId, 'rcp_v2')
    await seedSession({
      sessionId: 'ses_v2_new',
      receiptId: 'rcp_v2',
      startTs: '2026-05-19T11:00:00Z',
    })

    const page2 = await listSessions({ rawExec: makeRawExec(db) }, tenantId, {
      limit: 2,
      cursor: page1.nextCursor,
    })
    // Original v1 rows continue on page 2; the v2 row must NOT
    // surface because the cursor pins the snapshot.
    expect(page2.rows.map((r) => r.id)).toEqual(['ses_v1_2', 'ses_v1_3'])
    expect(page2.rows.every((r) => r.receiptId === 'rcp_v1')).toBe(true)
  })

  it('rejects a tampered cursor with InvalidCursorError', async () => {
    await setAuthority(db, tenantId, storeId, 'rcp_v1')
    await seedSession({ sessionId: 'ses_only', receiptId: 'rcp_v1', startTs: '2026-05-19T10:00:00Z' })
    await expect(
      listSessions({ rawExec: makeRawExec(db) }, tenantId, { limit: 10, cursor: '!!!not-a-cursor!!!' }),
    ).rejects.toBeInstanceOf(InvalidCursorError)

    const bogusButValidBase64 = Buffer.from(JSON.stringify({ startedAt: 'x', id: 'y' }), 'utf8').toString('base64url')
    await expect(
      listSessions({ rawExec: makeRawExec(db) }, tenantId, { limit: 10, cursor: bogusButValidBase64 }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })
})

describe('Lane 6 sessions/transcript — receipt-snapshot pin (CQ-142)', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  async function seedSession(receiptId: string) {
    await db.query(
      `INSERT INTO projection_session
         (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
          parent_resolution, timeline_confidence, payload)
       VALUES ($1, 'ses_t', $2, $3, 'codex', 'src_t', 'unresolved', 'high', '{}'::jsonb)
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET receipt_id = EXCLUDED.receipt_id`,
      [tenantId, storeId, receiptId],
    )
  }

  async function seedMessage(messageId: string, receiptId: string, ordinal: number, ts: string) {
    await db.query(
      `INSERT INTO projection_message
         (tenant_id, message_id, store_id, receipt_id, session_id, role, model, timestamp, ordinal, payload)
       VALUES ($1, $2, $3, $4, 'ses_t', 'user', 'm', $5::timestamptz, $6, '{}'::jsonb)`,
      [tenantId, messageId, storeId, receiptId, ts, ordinal],
    )
  }

  it('page 2 still uses the original snapshot after a mid-iteration promotion', async () => {
    await setAuthority(db, tenantId, storeId, 'rcp_v1')
    await seedSession('rcp_v1')
    await seedMessage('msg_v1_a', 'rcp_v1', 0, '2026-05-19T10:00:00Z')
    await seedMessage('msg_v1_b', 'rcp_v1', 1, '2026-05-19T10:01:00Z')

    const page1 = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
      sessionId: 'ses_t',
      limit: 1,
    })
    if (!page1) throw new Error('expected page1')
    expect(page1.turns.map((t) => t.messageId)).toEqual(['msg_v1_a'])
    expect(page1.nextCursor).not.toBeNull()

    // Promote: flip authority to v2 and add a v2-only message that
    // would normally surface under live resolution.
    await setAuthority(db, tenantId, storeId, 'rcp_v2')
    // Note: session row stays at v1 in our seeding; the gate is
    // pinned to v1 so the v2 message at receipt_id=rcp_v2 is
    // invisible to page 2.
    await seedMessage('msg_v2_x', 'rcp_v2', 2, '2026-05-19T10:00:30Z')

    const page2 = await getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
      sessionId: 'ses_t',
      limit: 1,
      cursor: page1.nextCursor,
    })
    if (!page2) throw new Error('expected page2')
    expect(page2.turns.map((t) => t.messageId)).toEqual(['msg_v1_b'])
  })

  it('rejects a tampered transcript cursor', async () => {
    await setAuthority(db, tenantId, storeId, 'rcp_v1')
    await seedSession('rcp_v1')
    await expect(
      getTranscriptPage({ rawExec: makeRawExec(db) }, tenantId, {
        sessionId: 'ses_t',
        limit: 10,
        cursor: 'totally-bogus',
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })
})

describe('Lane 6 search/query — receipt-snapshot pin (CQ-142)', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  async function seedDoc(docId: string, receiptId: string, text: string) {
    await db.query(
      `INSERT INTO search_doc
         (tenant_id, doc_id, store_id, receipt_id, entity_type, entity_id, field_kind, text, text_tsv)
       VALUES ($1, $2, $3, $4, 'message', $2, 'message_text', $5, to_tsvector('english', $5))`,
      [tenantId, docId, storeId, receiptId, text],
    )
  }

  it('page 2 still sees only v1 docs after the authority flips mid-iteration', async () => {
    await setAuthority(db, tenantId, storeId, 'rcp_v1')
    // Three v1 hits. The ranks must agree across runs; the seeded
    // texts differ slightly so ranks are stable.
    await seedDoc('doc_a', 'rcp_v1', 'fox alpha')
    await seedDoc('doc_b', 'rcp_v1', 'fox beta beta')
    await seedDoc('doc_c', 'rcp_v1', 'fox gamma gamma gamma')

    const page1 = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, { q: 'fox', limit: 1 })
    expect(page1.rows.length).toBe(1)
    expect(page1.nextCursor).not.toBeNull()

    await setAuthority(db, tenantId, storeId, 'rcp_v2')
    // A v2 hit with extreme term density would dominate the rank
    // if the gate re-resolved — the snapshot must hide it.
    await seedDoc('doc_v2_top', 'rcp_v2', 'fox fox fox fox fox fox fox fox')

    const collected: string[] = page1.rows.map((r) => r.docId)
    let cursor: string | null | undefined = page1.nextCursor
    let safety = 0
    while (cursor) {
      const page = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, { q: 'fox', limit: 1, cursor })
      for (const r of page.rows) collected.push(r.docId)
      cursor = page.nextCursor
      safety += 1
      if (safety > 10) throw new Error('runaway pagination')
    }
    expect(collected.sort()).toEqual(['doc_a', 'doc_b', 'doc_c'])
  })

  it('rejects a tampered search cursor', async () => {
    await setAuthority(db, tenantId, storeId, 'rcp_v1')
    await expect(
      searchQuery({ rawExec: makeRawExec(db) }, tenantId, { q: 'fox', limit: 10, cursor: 'tamper' }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })
})

describe('Lane 6 tool-calls/list — receipt-snapshot pin (CQ-142)', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  async function seedCall(toolCallId: string, receiptId: string, ts: string) {
    await db.query(
      `INSERT INTO projection_tool_call
         (tenant_id, tool_call_id, store_id, receipt_id, session_id, tool_name, timestamp_start, payload)
       VALUES ($1, $2, $3, $4, 'ses_a', 'bash', $5::timestamptz, '{}'::jsonb)`,
      [tenantId, toolCallId, storeId, receiptId, ts],
    )
  }

  it('page 2 still uses the original snapshot after a mid-iteration promotion', async () => {
    await setAuthority(db, tenantId, storeId, 'rcp_v1')
    await seedCall('tc_v1_0', 'rcp_v1', '2026-05-19T10:00:00Z')
    await seedCall('tc_v1_1', 'rcp_v1', '2026-05-19T10:01:00Z')
    await seedCall('tc_v1_2', 'rcp_v1', '2026-05-19T10:02:00Z')

    const page1 = await listToolCalls({ rawExec: makeRawExec(db) }, tenantId, { limit: 2 })
    expect(page1.rows.map((r) => r.toolCallId)).toEqual(['tc_v1_2', 'tc_v1_1'])
    expect(page1.nextCursor).not.toBeNull()

    await setAuthority(db, tenantId, storeId, 'rcp_v2')
    await seedCall('tc_v2_x', 'rcp_v2', '2026-05-19T10:03:00Z')

    const page2 = await listToolCalls({ rawExec: makeRawExec(db) }, tenantId, {
      limit: 2,
      cursor: page1.nextCursor,
    })
    // Only the third v1 call surfaces; the v2 call is invisible.
    expect(page2.rows.map((r) => r.toolCallId)).toEqual(['tc_v1_0'])
  })

  it('rejects a tampered tool-calls cursor', async () => {
    await setAuthority(db, tenantId, storeId, 'rcp_v1')
    await expect(
      listToolCalls({ rawExec: makeRawExec(db) }, tenantId, { limit: 10, cursor: 'tamper' }),
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })
})
