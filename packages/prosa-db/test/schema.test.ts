import { describe, expect, it } from 'vitest'
import { createTestDb } from '../src/testing.js'

describe('schema bootstrap', () => {
  it('creates auth and projection tables in pglite', async () => {
    const test = await createTestDb()
    try {
      const tables = await test.client.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      )
      const names = new Set(tables.rows.map((row) => row.tablename))
      for (const expected of [
        'user',
        'session',
        'organization',
        'member',
        'invitation',
        'device',
        'sync_batch',
        'remote_object',
        'tenant_object',
        'projection_session',
        'search_doc',
      ]) {
        expect(names.has(expected), `expected table ${expected}`).toBe(true)
      }
    } finally {
      await test.close()
    }
  })

  it('is idempotent under repeated bootstrap', async () => {
    const test = await createTestDb()
    try {
      await test.reset()
      await test.reset()
      const tables = await test.client.query<{ count: number }>(
        "SELECT count(*)::int as count FROM pg_tables WHERE schemaname = 'public'",
      )
      expect(tables.rows[0]?.count).toBeGreaterThan(20)
    } finally {
      await test.close()
    }
  })

  it('enforces tenant uniqueness on remote_authority store path', async () => {
    const test = await createTestDb()
    try {
      await test.client.exec(`
        INSERT INTO "user"(id, name, email) VALUES ('u1', 'alice', 'a@e.com');
        INSERT INTO "organization"(id, name) VALUES ('t1', 'TenantOne');
        INSERT INTO "device"(id, tenant_id, user_id, name) VALUES ('d1', 't1', 'u1', 'laptop');
        INSERT INTO "remote_authority"(tenant_id, device_id, store_path, promotion_receipt)
          VALUES ('t1', 'd1', '/tmp/.prosa', '{}'::jsonb);
      `)
      await expect(
        test.client.exec(
          `INSERT INTO "remote_authority"(tenant_id, device_id, store_path, promotion_receipt) VALUES ('t1', 'd1', '/tmp/.prosa', '{}'::jsonb);`,
        ),
      ).rejects.toThrow()
    } finally {
      await test.close()
    }
  })
})
