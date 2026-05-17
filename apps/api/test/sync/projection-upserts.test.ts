import { applySchema } from '@c3-oss/prosa-db'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { openPgliteDatabase } from '../../src/db.js'
import { insertProjectionRows } from '../../src/trpc/routers/sync/projection-upserts.js'

/**
 * Unit tests for the batch-upsert projection helpers.
 * These tests bypass the full HTTP stack and invoke `insertProjectionRows`
 * directly against an in-process PGlite database so they run fast and without
 * network dependencies.
 */

async function buildDb() {
  const pglite = new PGlite()
  await applySchema(pglite)
  const db = openPgliteDatabase(pglite)

  // Insert a minimal tenant row so FK constraints on projection tables pass.
  await db.rawExec(
    `INSERT INTO "organization"(id, name, slug, created_at)
     VALUES ($1, $2, $3, now())`,
    ['tenant-1', 'Test Tenant', 'test-tenant'],
  )

  // Insert a minimal user and device row for sync_batch FK.
  await db.rawExec(
    `INSERT INTO "user"(id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, true, now(), now())`,
    ['user-1', 'Test User', 'test@example.com'],
  )
  await db.rawExec(
    `INSERT INTO "device"(id, tenant_id, user_id, name, last_seen_at, created_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    ['device-1', 'tenant-1', 'user-1', 'laptop'],
  )

  // Insert a sync_batch row so projection manifest FK passes.
  await db.rawExec(
    `INSERT INTO "sync_batch"(id, tenant_id, device_id, user_id, store_path, status, object_count, row_count, bytes_uploaded, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'open', 0, 0, 0, now(), now())`,
    ['batch-1', 'tenant-1', 'device-1', 'user-1', '/tmp/test-store'],
  )

  return { db, pglite }
}

describe('insertProjectionRows — batch upserts', () => {
  it('inserts 3 sessions in a single call', async () => {
    const { db, pglite } = await buildDb()
    try {
      await insertProjectionRows({
        rawExec: db.rawExec,
        tenantId: 'tenant-1',
        batchId: 'batch-1',
        projection: {
          sessions: [
            { id: 'sess-1', sourceKind: 'codex', turnCount: 1 },
            { id: 'sess-2', sourceKind: 'claude', turnCount: 2, title: 'hello' },
            { id: 'sess-3', sourceKind: 'gemini', turnCount: 0, startedAt: '2026-01-01T00:00:00.000Z' },
          ],
          sourceFiles: [],
          rawRecords: [],
          searchDocs: [],
          toolCalls: [],
          toolResults: [],
          messages: [],
          contentBlocks: [],
          events: [],
          artifacts: [],
        },
      })

      const rows = await db.rawExec<{ id: string; source_kind: string; turn_count: number; title: string | null }>(
        `SELECT id, source_kind, turn_count, title FROM "projection_session" WHERE tenant_id = $1 ORDER BY id`,
        ['tenant-1'],
      )
      expect(rows).toHaveLength(3)
      expect(rows[0]).toMatchObject({ id: 'sess-1', source_kind: 'codex', turn_count: 1, title: null })
      expect(rows[1]).toMatchObject({ id: 'sess-2', source_kind: 'claude', turn_count: 2, title: 'hello' })
      expect(rows[2]).toMatchObject({ id: 'sess-3', source_kind: 'gemini', turn_count: 0 })

      // Manifest rows should also be present.
      const manifest = await db.rawExec<{ entity_type: string; entity_id: string }>(
        `SELECT entity_type, entity_id FROM "sync_batch_projection_manifest" WHERE tenant_id = $1 AND batch_id = $2 AND entity_type = 'session' ORDER BY entity_id`,
        ['tenant-1', 'batch-1'],
      )
      expect(manifest).toHaveLength(3)
      expect(manifest.map((r) => r.entity_id)).toEqual(['sess-1', 'sess-2', 'sess-3'])
    } finally {
      await pglite.close()
    }
  })

  it('rejects divergent replay and leaves the existing session unchanged', async () => {
    const { db, pglite } = await buildDb()
    try {
      const baseProjection = {
        sessions: [{ id: 'sess-1', sourceKind: 'codex', turnCount: 1, title: 'original' }],
        sourceFiles: [],
        rawRecords: [],
        searchDocs: [],
        toolCalls: [],
        toolResults: [],
        messages: [],
        contentBlocks: [],
        events: [],
        artifacts: [],
      }

      await insertProjectionRows({
        rawExec: db.rawExec,
        tenantId: 'tenant-1',
        batchId: 'batch-1',
        projection: baseProjection,
      })

      // Re-upsert with a different title and turnCount.
      await expect(
        insertProjectionRows({
          rawExec: db.rawExec,
          tenantId: 'tenant-1',
          batchId: 'batch-1',
          projection: {
            ...baseProjection,
            sessions: [{ id: 'sess-1', sourceKind: 'codex', turnCount: 5, title: 'updated' }],
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      const rows = await db.rawExec<{ id: string; turn_count: number; title: string | null }>(
        `SELECT id, turn_count, title FROM "projection_session" WHERE tenant_id = $1 AND id = $2`,
        ['tenant-1', 'sess-1'],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: 'sess-1', turn_count: 1, title: 'original' })

      // Manifest ON CONFLICT DO NOTHING — still 1 row (not duplicated).
      const manifest = await db.rawExec<{ entity_id: string }>(
        `SELECT entity_id FROM "sync_batch_projection_manifest" WHERE tenant_id = $1 AND batch_id = $2 AND entity_type = 'session'`,
        ['tenant-1', 'batch-1'],
      )
      expect(manifest).toHaveLength(1)
    } finally {
      await pglite.close()
    }
  })

  it('accepts replay with equivalent null, json, and timestamp forms', async () => {
    const { db, pglite } = await buildDb()
    try {
      const baseProjection = {
        sessions: [
          {
            id: 'sess-normalized',
            sourceKind: 'codex',
            turnCount: 1,
            startedAt: '2026-01-01T01:00:00.000+01:00',
            metadata: { b: 2, a: { d: 4, c: 3 } },
          },
        ],
        sourceFiles: [
          { id: 'source-normalized', sourceKind: 'codex', path: '/tmp/source.jsonl', metadata: { b: 2, a: 1 } },
        ],
        rawRecords: [
          {
            id: 'raw-normalized',
            sourceFileId: 'source-normalized',
            sequence: 0,
            payload: { value: 'same', importBatchId: 'volatile-a' },
          },
        ],
        searchDocs: [],
        toolCalls: [],
        toolResults: [],
        messages: [],
        contentBlocks: [],
        events: [],
        artifacts: [],
      }

      await insertProjectionRows({
        rawExec: db.rawExec,
        tenantId: 'tenant-1',
        batchId: 'batch-1',
        projection: baseProjection,
      })

      await insertProjectionRows({
        rawExec: db.rawExec,
        tenantId: 'tenant-1',
        batchId: 'batch-1',
        projection: {
          ...baseProjection,
          sessions: [
            {
              id: 'sess-normalized',
              sourceKind: 'codex',
              turnCount: 1,
              startedAt: '2026-01-01T00:00:00.000Z',
              metadata: { a: { c: 3, d: 4 }, b: 2 },
            },
          ],
          sourceFiles: [
            {
              id: 'source-normalized',
              sourceKind: 'codex',
              path: '/tmp/source.jsonl',
              objectId: null,
              metadata: { a: 1, b: 2 },
            },
          ],
          rawRecords: [
            {
              id: 'raw-normalized',
              sourceFileId: 'source-normalized',
              sequence: 0,
              objectId: null,
              payload: { importBatchId: 'volatile-b', value: 'same' },
            },
          ],
        },
      })

      const sessions = await db.rawExec<{ id: string }>(
        `SELECT id FROM "projection_session" WHERE tenant_id = $1 AND id = $2`,
        ['tenant-1', 'sess-normalized'],
      )
      expect(sessions).toHaveLength(1)
    } finally {
      await pglite.close()
    }
  })

  it('mixed batch (sessions + messages + content_blocks) inserts in correct FK order', async () => {
    const { db, pglite } = await buildDb()
    try {
      await insertProjectionRows({
        rawExec: db.rawExec,
        tenantId: 'tenant-1',
        batchId: 'batch-1',
        projection: {
          sessions: [{ id: 'sess-a', sourceKind: 'codex', turnCount: 1 }],
          sourceFiles: [],
          rawRecords: [],
          searchDocs: [{ id: 'doc-a', sessionId: 'sess-a', kind: 'session', body: 'hello' }],
          toolCalls: [
            { id: 'tc-a', sessionId: 'sess-a', name: 'bash', status: 'ok', createdAt: '2026-01-01T00:00:00.000Z' },
          ],
          toolResults: [{ id: 'tr-a', toolCallId: 'tc-a', status: 'ok', finishedAt: '2026-01-01T00:00:01.000Z' }],
          // messages must be inserted before contentBlocks (FK constraint)
          messages: [{ id: 'msg-a', sessionId: 'sess-a', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' }],
          contentBlocks: [{ id: 'cb-a', messageId: 'msg-a', sequence: 0, kind: 'text', text: 'hello world' }],
          events: [
            {
              id: 'ev-a',
              sessionId: 'sess-a',
              sequence: 0,
              kind: 'turn_start',
              occurredAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          artifacts: [{ id: 'art-a', kind: 'file', sessionId: 'sess-a', sizeBytes: 42 }],
        },
      })

      // Verify all entity tables received their rows.
      const sessRows = await db.rawExec(`SELECT id FROM "projection_session" WHERE tenant_id = $1`, ['tenant-1'])
      expect(sessRows).toHaveLength(1)

      const msgRows = await db.rawExec(`SELECT id FROM "projection_message" WHERE tenant_id = $1`, ['tenant-1'])
      expect(msgRows).toHaveLength(1)

      // contentBlocks reference messages — if FK violated, insert would have failed.
      const cbRows = await db.rawExec<{ id: string; message_id: string; text: string | null }>(
        `SELECT id, message_id, text FROM "projection_content_block" WHERE tenant_id = $1`,
        ['tenant-1'],
      )
      expect(cbRows).toHaveLength(1)
      expect(cbRows[0]).toMatchObject({ id: 'cb-a', message_id: 'msg-a', text: 'hello world' })

      const eventRows = await db.rawExec(`SELECT id FROM "projection_event" WHERE tenant_id = $1`, ['tenant-1'])
      expect(eventRows).toHaveLength(1)

      const artifactRows = await db.rawExec<{ id: string; size_bytes: string | number | null }>(
        `SELECT id, size_bytes FROM "projection_artifact" WHERE tenant_id = $1`,
        ['tenant-1'],
      )
      expect(artifactRows).toHaveLength(1)
      expect(Number(artifactRows[0]?.size_bytes)).toBe(42)

      // Total manifest entries: 1 session + 1 search_doc + 1 tool_call + 1 tool_result
      //                         + 1 message + 1 content_block + 1 event + 1 artifact = 8
      const manifestRows = await db.rawExec<{ entity_type: string }>(
        `SELECT entity_type FROM "sync_batch_projection_manifest" WHERE tenant_id = $1 AND batch_id = $2 ORDER BY entity_type, entity_id`,
        ['tenant-1', 'batch-1'],
      )
      expect(manifestRows).toHaveLength(8)

      const entityTypes = manifestRows.map((r) => r.entity_type).sort()
      expect(entityTypes).toEqual(
        ['artifact', 'content_block', 'event', 'message', 'search_doc', 'session', 'tool_call', 'tool_result'].sort(),
      )
    } finally {
      await pglite.close()
    }
  })
})
