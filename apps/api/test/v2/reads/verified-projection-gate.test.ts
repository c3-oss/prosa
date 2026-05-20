// Lane 6 — verified-projection gate pin.
//
// The shared SQL fragment in
// `apps/api/src/v2/reads/shared/verified-projection.ts` is the single
// source of truth for the receipt-pinned read gate. Every projection
// or search read must compose it so a row whose
// `(tenant_id, store_id, receipt_id)` triple does not point to the
// tenant's *current* `remote_authority_v2` is invisible.
//
// This test asserts the gate on a fresh v2-only PGlite (no v1 sync
// batch tables involved): we seed `projection_session` rows that mix
// current, superseded, and cross-tenant receipts, then probe the gate
// SQL directly. It also pins the lint surface — the list of tables
// any new read path must guard with the helper.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import {
  VERIFIED_PROJECTION_TABLES,
  verifiedProjectionWhere,
} from '../../../src/v2/reads/shared/verified-projection.js'

async function applyAuthority(
  db: PGlite,
  rows: Array<{ tenantId: string; storeId: string; receiptId: string; bundleRoot: string }>,
): Promise<void> {
  for (const row of rows) {
    await db.query(
      `INSERT INTO remote_authority_v2
         (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())`,
      [row.tenantId, row.storeId, row.receiptId, row.bundleRoot],
    )
  }
}

async function seedSession(
  db: PGlite,
  row: {
    tenantId: string
    storeId: string
    receiptId: string
    sessionId: string
    sourceTool: string
    sourceSessionId: string
    title: string
  },
): Promise<void> {
  await db.query(
    `INSERT INTO projection_session
       (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
        parent_resolution, timeline_confidence, title, payload)
     VALUES ($1, $2, $3, $4, $5, $6, 'unresolved', 'high', $7, '{}'::jsonb)`,
    [row.tenantId, row.sessionId, row.storeId, row.receiptId, row.sourceTool, row.sourceSessionId, row.title],
  )
}

describe('Lane 6 verified-projection gate', () => {
  it('lists VERIFIED_PROJECTION_TABLES so lint can catch new ungated read paths', () => {
    // Static contract: bump this list when adding a new projection /
    // search table. The lint test below greps every read source file
    // and refuses any non-shared read that touches one of these
    // tables without the gate helper.
    expect(VERIFIED_PROJECTION_TABLES).toContain('projection_session')
    expect(VERIFIED_PROJECTION_TABLES).toContain('projection_message')
    expect(VERIFIED_PROJECTION_TABLES).toContain('projection_tool_call')
    expect(VERIFIED_PROJECTION_TABLES).toContain('projection_tool_result')
    expect(VERIFIED_PROJECTION_TABLES).toContain('projection_event')
    expect(VERIFIED_PROJECTION_TABLES).toContain('projection_content_block')
    expect(VERIFIED_PROJECTION_TABLES).toContain('projection_artifact')
    expect(VERIFIED_PROJECTION_TABLES).toContain('search_doc')
  })

  it('emits a SQL fragment that resolves to a boolean predicate when joined to remote_authority_v2', async () => {
    const db = new PGlite()
    try {
      await applySchemaV2(db)
      const sql = `SELECT s.session_id FROM projection_session s WHERE ${verifiedProjectionWhere('s')} ORDER BY s.session_id`
      const result = await db.query<{ session_id: string }>(sql, ['t_x'])
      expect(result.rows).toEqual([])
    } finally {
      await db.close()
    }
  })

  it('returns only sessions whose receipt is the current authority for (tenant, store)', async () => {
    const db = new PGlite()
    try {
      await applySchemaV2(db)
      await applyAuthority(db, [
        { tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_current_a', bundleRoot: 'aa' },
        { tenantId: 't_a', storeId: 's_b', receiptId: 'rcp_current_b', bundleRoot: 'bb' },
        { tenantId: 't_other', storeId: 's_a', receiptId: 'rcp_other', bundleRoot: 'cc' },
      ])
      // Visible: matches current authority for (t_a, s_a).
      await seedSession(db, {
        tenantId: 't_a',
        storeId: 's_a',
        receiptId: 'rcp_current_a',
        sessionId: 'ses_visible_a',
        sourceTool: 'codex',
        sourceSessionId: 'src_a',
        title: 'visible-a',
      })
      // Visible: matches current authority for (t_a, s_b).
      await seedSession(db, {
        tenantId: 't_a',
        storeId: 's_b',
        receiptId: 'rcp_current_b',
        sessionId: 'ses_visible_b',
        sourceTool: 'codex',
        sourceSessionId: 'src_b',
        title: 'visible-b',
      })
      // Invisible: receipt id does not match current authority for store.
      await seedSession(db, {
        tenantId: 't_a',
        storeId: 's_a',
        receiptId: 'rcp_superseded_a',
        sessionId: 'ses_superseded',
        sourceTool: 'codex',
        sourceSessionId: 'src_super',
        title: 'superseded',
      })
      // Invisible: store has no authority at all for this tenant.
      await seedSession(db, {
        tenantId: 't_a',
        storeId: 's_unmapped',
        receiptId: 'rcp_orphan',
        sessionId: 'ses_orphan',
        sourceTool: 'codex',
        sourceSessionId: 'src_orphan',
        title: 'orphan-store',
      })

      const sql = `SELECT s.session_id, s.store_id FROM projection_session s
                    WHERE ${verifiedProjectionWhere('s')}
                    ORDER BY s.session_id`
      const result = await db.query<{ session_id: string; store_id: string }>(sql, ['t_a'])
      expect(result.rows.map((r) => r.session_id)).toEqual(['ses_visible_a', 'ses_visible_b'])
    } finally {
      await db.close()
    }
  })

  it('is tenant scoped: a session belonging to another tenant never surfaces under the caller', async () => {
    const db = new PGlite()
    try {
      await applySchemaV2(db)
      await applyAuthority(db, [
        { tenantId: 't_attacker', storeId: 's_x', receiptId: 'rcp_attacker', bundleRoot: 'aa' },
        { tenantId: 't_victim', storeId: 's_x', receiptId: 'rcp_victim', bundleRoot: 'bb' },
      ])
      await seedSession(db, {
        tenantId: 't_victim',
        storeId: 's_x',
        receiptId: 'rcp_victim',
        sessionId: 'ses_secret',
        sourceTool: 'codex',
        sourceSessionId: 'src_secret',
        title: 'do-not-leak',
      })

      // Even if the attacker happens to have authority for the same
      // store id, they must not see the victim's row — the gate is
      // keyed on the projection row's tenant_id, not a global store
      // id namespace.
      const sql = `SELECT s.session_id FROM projection_session s WHERE ${verifiedProjectionWhere('s')}`
      const attackerView = await db.query<{ session_id: string }>(sql, ['t_attacker'])
      expect(attackerView.rows).toEqual([])
      const victimView = await db.query<{ session_id: string }>(sql, ['t_victim'])
      expect(victimView.rows.map((r) => r.session_id)).toEqual(['ses_secret'])
    } finally {
      await db.close()
    }
  })

  it('reflects a fresh promotion immediately: bumping current_receipt_id swaps the visible row set', async () => {
    const db = new PGlite()
    try {
      await applySchemaV2(db)
      await applyAuthority(db, [{ tenantId: 't_a', storeId: 's_a', receiptId: 'rcp_old', bundleRoot: 'aa' }])
      await seedSession(db, {
        tenantId: 't_a',
        storeId: 's_a',
        receiptId: 'rcp_old',
        sessionId: 'ses_old',
        sourceTool: 'codex',
        sourceSessionId: 'src_old',
        title: 'old',
      })
      await seedSession(db, {
        tenantId: 't_a',
        storeId: 's_a',
        receiptId: 'rcp_new',
        sessionId: 'ses_new',
        sourceTool: 'codex',
        sourceSessionId: 'src_new',
        title: 'new',
      })
      const sql = `SELECT s.session_id FROM projection_session s WHERE ${verifiedProjectionWhere('s')} ORDER BY s.session_id`
      const before = await db.query<{ session_id: string }>(sql, ['t_a'])
      expect(before.rows.map((r) => r.session_id)).toEqual(['ses_old'])
      await db.query(
        `UPDATE remote_authority_v2 SET current_receipt_id = $1, current_bundle_root = 'bb', promoted_at = now()
          WHERE tenant_id = $2 AND store_id = $3`,
        ['rcp_new', 't_a', 's_a'],
      )
      const after = await db.query<{ session_id: string }>(sql, ['t_a'])
      expect(after.rows.map((r) => r.session_id)).toEqual(['ses_new'])
    } finally {
      await db.close()
    }
  })
})
