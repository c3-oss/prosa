import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

import { REQUIRED_TABLES, SchemaCheckError, applySchemaV2, assertSchemaV2 } from '../src/index.js'

describe('applySchemaV2', () => {
  it('applies the full v2 schema cleanly to a fresh pglite database', async () => {
    const db = new PGlite()
    await applySchemaV2(db)
    // Every required table must exist after one apply.
    await assertSchemaV2(db)
    await db.close()
  })

  it('is idempotent — re-running against the same database is a no-op', async () => {
    const db = new PGlite()
    await applySchemaV2(db)
    await applySchemaV2(db)
    await applySchemaV2(db)
    await assertSchemaV2(db)
    await db.close()
  })

  it('REQUIRED_TABLES covers the load-bearing v2 tables', () => {
    // Catch a typo or accidental removal: the list must include the
    // critical tables the API boot check protects.
    const mandatory = [
      'device',
      'promotion_staging',
      'remote_authority_v2',
      'remote_pack',
      'projection_session',
      'search_doc',
    ]
    for (const t of mandatory) {
      expect(REQUIRED_TABLES).toContain(t)
    }
  })

  it('assertSchemaV2 throws SchemaCheckError when a required table is missing', async () => {
    const db = new PGlite()
    await applySchemaV2(db)
    await db.exec('DROP TABLE projection_session CASCADE')
    await expect(assertSchemaV2(db)).rejects.toBeInstanceOf(SchemaCheckError)
  })

  it('projection_session round-trips a JSONB payload', async () => {
    const db = new PGlite()
    await applySchemaV2(db)
    await db.exec(`
      INSERT INTO projection_session
        (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
         parent_resolution, timeline_confidence, payload)
      VALUES
        ('t_a', 'ses_a', 'store_a', 'rcp_a', 'codex', 'src_a', 'unresolved', 'high',
         '{"hello":"world"}'::jsonb)
    `)
    const r = await db.query<{ session_id: string; payload: { hello: string } }>(
      `SELECT session_id, payload FROM projection_session WHERE tenant_id = 't_a'`,
    )
    expect(r.rows.length).toBe(1)
    expect(r.rows[0]?.session_id).toBe('ses_a')
    expect(r.rows[0]?.payload?.hello).toBe('world')
    await db.close()
  })

  it('search_doc accepts a text_tsv update via to_tsvector', async () => {
    const db = new PGlite()
    await applySchemaV2(db)
    await db.exec(`
      INSERT INTO search_doc
        (tenant_id, doc_id, store_id, receipt_id, entity_type, entity_id, field_kind, text, text_tsv)
      VALUES
        ('t_a', 'sdc_a', 'store_a', 'rcp_a', 'message', 'msg_a', 'message_text',
         'the quick brown fox', to_tsvector('english', 'the quick brown fox'))
    `)
    const r = await db.query<{ doc_id: string }>(
      `SELECT doc_id FROM search_doc
       WHERE tenant_id = 't_a' AND text_tsv @@ to_tsquery('english', 'fox')`,
    )
    expect(r.rows.length).toBe(1)
    await db.close()
  })
})
