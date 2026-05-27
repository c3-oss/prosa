// G7 cutover — covers `parseProjectionSegments` + `insertParsedProjection`
// directly against PGlite + MemoryObjectStore so a regression in the
// NDJSON parser, the per-entity INSERT shapes, or ON CONFLICT ergonomics
// is caught without standing up the full seal-promotion flow.

import { applySchema } from '@c3-oss/prosa-db'
import { applyV2ProjectionCutover, applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { openPgliteDatabase } from '../../../src/db.js'
import { insertParsedProjection, parseProjectionSegments } from '../../../src/v2/sync/seal-materialize.js'

const tenantId = 'tenant-g7-test'
const promotionId = 'prm_g7test'
const storeId = 'store-g7-test'
const receiptId = 'rcpt_g7test'

async function* asyncOnce(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

function ndjsonSegment(entityType: string, rows: Array<Record<string, unknown>>): Uint8Array {
  const header = JSON.stringify({
    bundleFormat: 2,
    segmentKind: 'projection_ndjson',
    entityType,
    rowCount: rows.length,
  })
  const lines = [header, ...rows.map((r) => JSON.stringify(r))]
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

function stagingKey(segmentId: string): string {
  return `staging/${tenantId}/${promotionId}/${segmentId}`
}

async function uploadSegment(store: MemoryObjectStore, segmentId: string, bytes: Uint8Array): Promise<void> {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  await store.putIfAbsent(stagingKey(segmentId), asyncOnce(bytes), {
    hash: hex,
    hashAlgorithm: 'blake3',
    uncompressedSize: bytes.byteLength,
    compressedSize: bytes.byteLength,
  })
}

async function setup() {
  const pglite = new PGlite()
  // The cutover relies on v1 having created the projection_* tables;
  // otherwise the DROP IF EXISTS path is a no-op but applySchema is
  // still needed for FK-referenced auxiliary tables on the v1 side.
  await applySchema(pglite)
  await applyV2PromotionSubsetSchema(pglite)
  await applyV2ProjectionCutover(pglite)
  const db = openPgliteDatabase(pglite)
  const objectStore = new MemoryObjectStore()
  return { pglite, db, objectStore }
}

describe('G7 seal materialization', () => {
  it('parses NDJSON segments and inserts rows into projection_<entity>', async () => {
    const { pglite, db, objectStore } = await setup()
    try {
      const sessionRows = [
        {
          session_id: 's1',
          source_tool: 'codex',
          source_session_id: 's1-src',
          parent_resolution: 'resolved',
          is_subagent: false,
          timeline_confidence: 'high',
          title: 'first session',
          start_ts: '2026-05-21T00:00:00.000Z',
        },
      ]
      const messageRows = [
        { message_id: 'm1', session_id: 's1', role: 'user', ordinal: 0, timestamp: '2026-05-21T00:00:01.000Z' },
        { message_id: 'm2', session_id: 's1', role: 'assistant', ordinal: 1, timestamp: '2026-05-21T00:00:02.000Z' },
      ]
      const toolCallRows = [
        { tool_call_id: 'tc1', session_id: 's1', tool_name: 'shell', timestamp_start: '2026-05-21T00:00:03.000Z' },
      ]

      const sessionBytes = ndjsonSegment('session', sessionRows)
      const messageBytes = ndjsonSegment('message', messageRows)
      const toolCallBytes = ndjsonSegment('tool_call', toolCallRows)
      await uploadSegment(objectStore, 'seg_session', sessionBytes)
      await uploadSegment(objectStore, 'seg_message', messageBytes)
      await uploadSegment(objectStore, 'seg_toolcall', toolCallBytes)

      const segments = [
        { segmentId: 'seg_session', kind: 'projection_arrow', entityType: 'session' as const },
        { segmentId: 'seg_message', kind: 'projection_arrow', entityType: 'message' as const },
        { segmentId: 'seg_toolcall', kind: 'projection_arrow', entityType: 'tool_call' as const },
        // Non-projection segments are skipped without error.
        { segmentId: 'seg_pack', kind: 'cas_object_pack' as const },
      ]

      const parsed = await parseProjectionSegments({ objectStore, tenantId }, { promotionId, segments })
      expect(parsed.counts).toEqual({ session: 1, message: 2, tool_call: 1 })

      await db.transaction(async (tx) => {
        await insertParsedProjection(tx, { tenantId, storeId, receiptId, parsed })
      })

      const sessions = await db.rawExec<{ session_id: string; store_id: string; receipt_id: string; title: string }>(
        'SELECT session_id, store_id, receipt_id, title FROM projection_session WHERE tenant_id = $1',
        [tenantId],
      )
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({
        session_id: 's1',
        store_id: storeId,
        receipt_id: receiptId,
        title: 'first session',
      })

      const messages = await db.rawExec<{ message_id: string; role: string; ordinal: number }>(
        'SELECT message_id, role, ordinal FROM projection_message WHERE tenant_id = $1 ORDER BY ordinal',
        [tenantId],
      )
      expect(messages.map((m) => m.message_id)).toEqual(['m1', 'm2'])
      expect(messages[0]?.role).toBe('user')

      const toolCalls = await db.rawExec<{ tool_call_id: string; tool_name: string }>(
        'SELECT tool_call_id, tool_name FROM projection_tool_call WHERE tenant_id = $1',
        [tenantId],
      )
      expect(toolCalls).toEqual([{ tool_call_id: 'tc1', tool_name: 'shell' }])
    } finally {
      await pglite.close()
    }
  })

  it('re-runs idempotently — ON CONFLICT DO UPDATE replaces store_id / receipt_id without duplicating rows', async () => {
    const { pglite, db, objectStore } = await setup()
    try {
      const rows = [
        {
          session_id: 'sx',
          source_tool: 'codex',
          source_session_id: 'sx',
          parent_resolution: 'unresolved',
          is_subagent: false,
          timeline_confidence: 'high',
        },
      ]
      await uploadSegment(objectStore, 'seg_session', ndjsonSegment('session', rows))
      const segments = [{ segmentId: 'seg_session', kind: 'projection_arrow', entityType: 'session' as const }]
      const parsed = await parseProjectionSegments({ objectStore, tenantId }, { promotionId, segments })

      await db.transaction(async (tx) => {
        await insertParsedProjection(tx, { tenantId, storeId, receiptId, parsed })
      })
      await db.transaction(async (tx) => {
        await insertParsedProjection(tx, { tenantId, storeId, receiptId: 'rcpt_g7test2', parsed })
      })

      const sessions = await db.rawExec<{ session_id: string; receipt_id: string }>(
        'SELECT session_id, receipt_id FROM projection_session WHERE tenant_id = $1',
        [tenantId],
      )
      expect(sessions).toEqual([{ session_id: 'sx', receipt_id: 'rcpt_g7test2' }])
    } finally {
      await pglite.close()
    }
  })

  it('rejects a segment with a mismatched header entity type', async () => {
    const { pglite, objectStore } = await setup()
    try {
      // NDJSON declares `entityType: message` but the caller maps the
      // same segmentId to `session`. Phase 1 fails closed.
      await uploadSegment(objectStore, 'seg_bad', ndjsonSegment('message', [{ message_id: 'm1' }]))
      const segments = [{ segmentId: 'seg_bad', kind: 'projection_arrow', entityType: 'session' as const }]
      await expect(parseProjectionSegments({ objectStore, tenantId }, { promotionId, segments })).rejects.toThrow(
        /malformed header/,
      )
    } finally {
      await pglite.close()
    }
  })

  it('fails closed when the segment is not uploaded to the object store', async () => {
    const { pglite, objectStore } = await setup()
    try {
      const segments = [{ segmentId: 'seg_missing', kind: 'projection_arrow', entityType: 'session' as const }]
      await expect(parseProjectionSegments({ objectStore, tenantId }, { promotionId, segments })).rejects.toThrow(
        /no bytes/,
      )
    } finally {
      await pglite.close()
    }
  })
})
