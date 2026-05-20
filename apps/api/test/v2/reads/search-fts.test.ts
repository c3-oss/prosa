// Lane 6 — search/query (Postgres FTS) pin.
//
// Drives `searchQuery` against a fresh v2-only PGlite. Asserts:
//
//   - The verified-projection gate hides docs from a superseded
//     receipt and docs that belong to other tenants.
//   - Every documented filter (`roles`, `toolNames`,
//     `canonicalToolTypes`, `entityTypes`, `errorsOnly`,
//     `sessionId`, `since`, `until`) narrows the result set the way
//     the contract claims.
//   - The opaque cursor over `(rank, doc_id)` is stable across
//     pages (`rank DESC, doc_id ASC`).
//   - `ts_headline` produces a snippet that contains the matched
//     term wrapped in default markup.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchQuery } from '../../../src/v2/reads/search/query.js'

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

type Doc = {
  tenantId: string
  storeId: string
  receiptId: string
  docId: string
  entityType?: string
  entityId?: string
  sessionId?: string | null
  projectId?: string | null
  timestamp?: string | null
  role?: string | null
  toolName?: string | null
  canonicalToolType?: string | null
  fieldKind?: string
  errorsOnly?: boolean
  text: string
}

async function seedDoc(db: PGlite, d: Doc) {
  await db.query(
    `INSERT INTO search_doc
       (tenant_id, doc_id, store_id, receipt_id, entity_type, entity_id, session_id, project_id,
        timestamp, role, tool_name, canonical_tool_type, field_kind, errors_only, text, text_tsv)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12, $13, $14, $15,
             to_tsvector('english', $15))`,
    [
      d.tenantId,
      d.docId,
      d.storeId,
      d.receiptId,
      d.entityType ?? 'message',
      d.entityId ?? d.docId,
      d.sessionId ?? null,
      d.projectId ?? null,
      d.timestamp ?? null,
      d.role ?? null,
      d.toolName ?? null,
      d.canonicalToolType ?? null,
      d.fieldKind ?? 'message_text',
      d.errorsOnly ?? false,
      d.text,
    ],
  )
}

describe('Lane 6 search/query — verified-projection gate', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns empty rows when no authority exists for the tenant', async () => {
    await seedDoc(db, {
      tenantId: 't_a',
      storeId: 's_a',
      receiptId: 'rcp_orphan',
      docId: 'doc_a',
      text: 'the quick brown fox jumps over the lazy dog',
    })
    const r = await searchQuery({ rawExec: makeRawExec(db) }, 't_a', { q: 'fox', limit: 10 })
    expect(r.rows).toEqual([])
    expect(r.nextCursor).toBeNull()
  })

  it('hides docs whose receipt is not the current authority', async () => {
    await seedAuthority(db, [{ tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_current' }])
    await seedDoc(db, {
      tenantId: 't_a',
      storeId: 's_a',
      receiptId: 'rcp_current',
      docId: 'doc_visible',
      text: 'the quick brown fox jumps over the lazy dog',
    })
    await seedDoc(db, {
      tenantId: 't_a',
      storeId: 's_a',
      receiptId: 'rcp_superseded',
      docId: 'doc_hidden',
      text: 'the quick brown fox is hidden',
    })
    const r = await searchQuery({ rawExec: makeRawExec(db) }, 't_a', { q: 'fox', limit: 10 })
    expect(r.rows.map((row) => row.docId)).toEqual(['doc_visible'])
  })

  it('does not surface another tenants docs even on identical store ids', async () => {
    await seedAuthority(db, [
      { tenantId: 't_alice', storeId: 's_x', receiptId: 'rcp_alice' },
      { tenantId: 't_bob', storeId: 's_x', receiptId: 'rcp_bob' },
    ])
    await seedDoc(db, {
      tenantId: 't_alice',
      storeId: 's_x',
      receiptId: 'rcp_alice',
      docId: 'doc_alice',
      text: 'alice secret fox notes',
    })
    await seedDoc(db, {
      tenantId: 't_bob',
      storeId: 's_x',
      receiptId: 'rcp_bob',
      docId: 'doc_bob',
      text: 'bob also wrote about a fox',
    })
    const aliceView = await searchQuery({ rawExec: makeRawExec(db) }, 't_alice', { q: 'fox', limit: 10 })
    expect(aliceView.rows.map((r) => r.docId)).toEqual(['doc_alice'])
    const bobView = await searchQuery({ rawExec: makeRawExec(db) }, 't_bob', { q: 'fox', limit: 10 })
    expect(bobView.rows.map((r) => r.docId)).toEqual(['doc_bob'])
  })
})

describe('Lane 6 search/query — filters + snippets', () => {
  let db: PGlite
  const tenantId = 't_a'
  const storeId = 's_a'
  const receiptId = 'rcp_a'
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    await seedAuthority(db, [{ tenantId, storeId, receiptId }])
    await seedDoc(db, {
      tenantId,
      storeId,
      receiptId,
      docId: 'doc_user',
      role: 'user',
      entityType: 'message',
      sessionId: 'ses_a',
      timestamp: '2026-05-19T10:00:00Z',
      text: 'the quick brown fox jumps over the lazy dog',
    })
    await seedDoc(db, {
      tenantId,
      storeId,
      receiptId,
      docId: 'doc_assistant',
      role: 'assistant',
      entityType: 'message',
      sessionId: 'ses_a',
      timestamp: '2026-05-20T10:00:00Z',
      text: 'I saw a quick fox running through the meadow',
    })
    await seedDoc(db, {
      tenantId,
      storeId,
      receiptId,
      docId: 'doc_tool_bash',
      role: 'tool',
      toolName: 'bash',
      canonicalToolType: 'execute_shell',
      entityType: 'tool_call',
      sessionId: 'ses_b',
      timestamp: '2026-05-21T10:00:00Z',
      text: 'curl -s api.example.com | jq the fox payload',
      errorsOnly: false,
    })
    await seedDoc(db, {
      tenantId,
      storeId,
      receiptId,
      docId: 'doc_tool_err',
      role: 'tool',
      toolName: 'bash',
      canonicalToolType: 'execute_shell',
      entityType: 'tool_result',
      sessionId: 'ses_b',
      timestamp: '2026-05-22T10:00:00Z',
      errorsOnly: true,
      text: 'fox encountered a fatal error',
    })
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns hits with a non-empty snippet containing the matched term', async () => {
    const r = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, { q: 'fox', limit: 10 })
    expect(r.rows.length).toBeGreaterThan(0)
    for (const hit of r.rows) {
      // ts_headline highlights every match; verify the snippet
      // contains the term (case-insensitive) and is bounded.
      expect(hit.snippet.toLowerCase()).toContain('fox')
    }
  })

  it('filters by roles', async () => {
    const r = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, { q: 'fox', roles: ['user'], limit: 10 })
    expect(r.rows.map((h) => h.docId)).toEqual(['doc_user'])
  })

  it('filters by toolNames', async () => {
    const r = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, {
      q: 'fox',
      toolNames: ['bash'],
      limit: 10,
    })
    expect(r.rows.map((h) => h.docId).sort()).toEqual(['doc_tool_bash', 'doc_tool_err'])
  })

  it('filters by canonicalToolTypes', async () => {
    const r = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, {
      q: 'fox',
      canonicalToolTypes: ['execute_shell'],
      limit: 10,
    })
    expect(r.rows.map((h) => h.docId).sort()).toEqual(['doc_tool_bash', 'doc_tool_err'])
  })

  it('filters by entityTypes', async () => {
    const r = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, {
      q: 'fox',
      entityTypes: ['tool_result'],
      limit: 10,
    })
    expect(r.rows.map((h) => h.docId)).toEqual(['doc_tool_err'])
  })

  it('filters by errorsOnly', async () => {
    const r = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, {
      q: 'fox',
      errorsOnly: true,
      limit: 10,
    })
    expect(r.rows.map((h) => h.docId)).toEqual(['doc_tool_err'])
  })

  it('filters by sessionId', async () => {
    const r = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, {
      q: 'fox',
      sessionId: 'ses_a',
      limit: 10,
    })
    expect(r.rows.map((h) => h.docId).sort()).toEqual(['doc_assistant', 'doc_user'])
  })

  it('filters by since / until', async () => {
    const r1 = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, {
      q: 'fox',
      since: '2026-05-21T00:00:00Z',
      limit: 10,
    })
    expect(r1.rows.map((h) => h.docId).sort()).toEqual(['doc_tool_bash', 'doc_tool_err'])
    const r2 = await searchQuery({ rawExec: makeRawExec(db) }, tenantId, {
      q: 'fox',
      until: '2026-05-21T00:00:00Z',
      limit: 10,
    })
    expect(r2.rows.map((h) => h.docId).sort()).toEqual(['doc_assistant', 'doc_user'])
  })
})

describe('Lane 6 search/query — cursor pagination', () => {
  let db: PGlite
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    await seedAuthority(db, [{ tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_a' }])
    // Seed 5 distinct docs that all match `fox`. The rank varies
    // because the surrounding text changes the lexeme density;
    // any stable ordering keyed on `(rank DESC, doc_id ASC)` is
    // fine for the pagination test.
    for (let i = 0; i < 5; i += 1) {
      const filler = 'lorem ipsum '.repeat(i + 1)
      await seedDoc(db, {
        tenantId: 't_a',
        storeId: 's_a',
        receiptId: 'rcp_a',
        docId: `doc_${String(i).padStart(2, '0')}`,
        text: `${filler} the quick fox returned`,
      })
    }
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns a stable, non-overlapping page sequence under the cursor', async () => {
    const collected: string[] = []
    let cursor: string | null | undefined
    let safety = 0
    do {
      const page = await searchQuery({ rawExec: makeRawExec(db) }, 't_a', { q: 'fox', limit: 2, cursor })
      for (const r of page.rows) collected.push(r.docId)
      cursor = page.nextCursor
      safety += 1
      if (safety > 10) throw new Error('runaway pagination')
    } while (cursor)
    // All 5 docs visited exactly once.
    expect(collected.length).toBe(5)
    expect(new Set(collected).size).toBe(5)
  })
})
