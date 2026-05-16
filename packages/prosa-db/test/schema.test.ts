import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  account,
  device,
  deviceCode,
  invitation,
  jwks,
  member,
  organization,
  remoteAuthority,
  remoteBlob,
  remoteObject,
  remoteObjectLocation,
  session,
  syncBatch,
  syncBatchObjectManifest,
  syncBatchProjectionManifest,
  syncCommitIdempotency,
  syncSource,
  tenantObject,
  user,
  verification,
} from '../src/schema/index.js'
import { projection } from '../src/schema/index.js'
import { createTestDb } from '../src/testing.js'

describe('schema bootstrap', () => {
  it('exports every table used by migrations and app queries', () => {
    const tables = [
      user,
      session,
      account,
      verification,
      organization,
      member,
      invitation,
      deviceCode,
      jwks,
      device,
      syncBatch,
      syncCommitIdempotency,
      syncBatchObjectManifest,
      syncBatchProjectionManifest,
      syncSource,
      remoteAuthority,
      remoteObject,
      remoteBlob,
      remoteObjectLocation,
      tenantObject,
      projection.sourceFile,
      projection.importBatch,
      projection.rawRecord,
      projection.project,
      projection.session,
      projection.turn,
      projection.event,
      projection.message,
      projection.contentBlock,
      projection.toolCall,
      projection.toolResult,
      projection.artifact,
      projection.edge,
      projection.searchDoc,
    ]

    expect(tables.map((table) => getTableName(table))).toEqual([
      'user',
      'session',
      'account',
      'verification',
      'organization',
      'member',
      'invitation',
      'device_code',
      'jwks',
      'device',
      'sync_batch',
      'sync_commit_idempotency',
      'sync_batch_object_manifest',
      'sync_batch_projection_manifest',
      'sync_source',
      'remote_authority',
      'remote_object',
      'remote_blob',
      'remote_object_location',
      'tenant_object',
      'source_file',
      'import_batch',
      'raw_record',
      'project',
      'projection_session',
      'projection_turn',
      'projection_event',
      'projection_message',
      'projection_content_block',
      'projection_tool_call',
      'projection_tool_result',
      'projection_artifact',
      'projection_edge',
      'search_doc',
    ])

    const configs = tables.map((table) => getTableConfig(table))
    expect(configs.flatMap((config) => config.columns)).not.toHaveLength(0)
    expect(configs.flatMap((config) => config.indexes)).not.toHaveLength(0)
    expect(configs.flatMap((config) => config.primaryKeys)).not.toHaveLength(0)
    expect(configs.flatMap((config) => config.foreignKeys)).not.toHaveLength(0)
  })

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
        'sync_commit_idempotency',
        'remote_object',
        'remote_blob',
        'remote_object_location',
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
