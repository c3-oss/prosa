// CQ-137 follow-up: re-applying `SEARCH_SCHEMA_SQL` to a
// database that still has the original
// `search_generation_current(tenant_id PRIMARY KEY, ...)` shape
// must migrate the table to the new composite key
// `(tenant_id, store_id)`. Reviewer flagged that the previous
// closure relied on a fresh schema; an in-place upgrade left
// the old PK and broke seal.

import { SEARCH_SCHEMA_SQL } from '@c3-oss/prosa-db-v2'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

async function runOldShape(pglite: PGlite): Promise<void> {
  // Seed the legacy shape — what existed in the slice 5
  // commit before CQ-137 was raised.
  await pglite.exec(`
    CREATE TABLE search_generation_current (
      tenant_id              TEXT PRIMARY KEY,
      generation_id          TEXT NOT NULL,
      receipt_id             TEXT NOT NULL,
      promoted_at            TIMESTAMPTZ NOT NULL,
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  // Seed a row so we can prove the migration preserves data.
  await pglite.exec(`
    INSERT INTO search_generation_current (tenant_id, generation_id, receipt_id, promoted_at)
    VALUES ('tenant-cq137-mig', 'gen-old', 'rcpt_legacy', now());
  `)
}

async function pkColumns(pglite: PGlite): Promise<string[]> {
  const result = await pglite.query<{ attname: string }>(`
    SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'search_generation_current'::regclass
       AND i.indisprimary
     ORDER BY a.attnum
  `)
  return result.rows.map((r) => r.attname)
}

describe('CQ-137: idempotent search_generation_current migration', () => {
  it('upgrades a legacy tenant-pk table to the composite (tenant_id, store_id) key', async () => {
    const pglite = new PGlite()
    try {
      await runOldShape(pglite)
      expect(await pkColumns(pglite)).toEqual(['tenant_id'])

      // Re-apply the canonical schema. The `CREATE TABLE IF NOT
      // EXISTS` is a no-op; the migration block does the work.
      await pglite.exec(SEARCH_SCHEMA_SQL)

      // PK is now composite.
      expect(await pkColumns(pglite)).toEqual(['tenant_id', 'store_id'])

      // The pre-existing row is preserved with a non-null store_id.
      const rows = await pglite.query<{ tenant_id: string; store_id: string; generation_id: string }>(`
        SELECT tenant_id, store_id, generation_id FROM search_generation_current
      `)
      expect(rows.rows.length).toBe(1)
      expect(rows.rows[0]!.tenant_id).toBe('tenant-cq137-mig')
      expect(rows.rows[0]!.store_id).toBe('')
      expect(rows.rows[0]!.generation_id).toBe('gen-old')

      // The new composite key lets two stores in the same tenant
      // coexist — the bug the original CQ flagged.
      await pglite.exec(`
        INSERT INTO search_generation_current (tenant_id, store_id, generation_id, receipt_id, promoted_at)
        VALUES ('tenant-cq137-mig', 'store-b', 'gen-b', 'rcpt_b', now());
      `)
      const all = await pglite.query<{ store_id: string }>(`
        SELECT store_id FROM search_generation_current WHERE tenant_id = 'tenant-cq137-mig'
        ORDER BY store_id ASC
      `)
      expect(all.rows.map((r) => r.store_id)).toEqual(['', 'store-b'])
    } finally {
      await pglite.close()
    }
  })

  it('is a no-op on a fresh database where the new shape already exists', async () => {
    const pglite = new PGlite()
    try {
      // First apply produces the new shape directly via CREATE.
      await pglite.exec(SEARCH_SCHEMA_SQL)
      expect(await pkColumns(pglite)).toEqual(['tenant_id', 'store_id'])

      // Re-applying must be idempotent — the migration block
      // skips the PK swap when the table is already keyed by
      // (tenant_id, store_id).
      await pglite.exec(SEARCH_SCHEMA_SQL)
      expect(await pkColumns(pglite)).toEqual(['tenant_id', 'store_id'])
    } finally {
      await pglite.close()
    }
  })
})
