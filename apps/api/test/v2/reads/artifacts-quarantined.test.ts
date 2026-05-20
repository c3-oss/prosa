// Lane 8 — `artifacts.getText` short-circuits with a typed
// `data_unavailable` shape when the underlying pack has been
// quarantined by the audit cron.
//
// The HTTP route maps the typed shape to `503 DATA_UNAVAILABLE`.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore, PUT_PREVERIFIED_BYTES } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ArtifactMissReason, getArtifactText } from '../../../src/v2/reads/artifacts/get-text.js'

async function putBytes(store: MemoryObjectStore, key: string, bytes: Buffer): Promise<void> {
  await store[PUT_PREVERIFIED_BYTES](
    key,
    (async function* () {
      yield new Uint8Array(bytes)
    })(),
    { hash: 'h', hashAlgorithm: 'blake3', uncompressedSize: bytes.length, compressedSize: bytes.length },
  )
}

function makeRawExec(db: PGlite) {
  return async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await db.query<Row>(sql, params)
    return res.rows
  }
}

const tenantId = 't_quar'
const storeId = 's_quar'
const receiptId = 'rcp_quar'
const packDigest = 'pack_quar'
const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`
const objectId = 'blake3:deadbeef'

async function seedFullChain(db: PGlite): Promise<void> {
  const body = Buffer.from('payload that will be denied because the pack is quarantined', 'utf8')
  await db.query(
    `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())`,
    [tenantId, storeId, receiptId, 'aa'.repeat(16)],
  )
  await db.query(
    `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri)
       VALUES ($1, $2, 'cas_object_pack', 1, $3, 'root', $4)`,
    [tenantId, packDigest, body.length, storageUri],
  )
  await db.query(
    `INSERT INTO remote_pack_entry (tenant_id, pack_digest, entry_index, object_id, uncompressed_size, stored_offset, stored_length, stored_hash, compression)
       VALUES ($1, $2, 0, $3, $4, 0, $4, 'h', 'none')`,
    [tenantId, packDigest, objectId, body.length],
  )
  await db.query(`INSERT INTO receipt_pack_grant (receipt_id, tenant_id, pack_digest) VALUES ($1, $2, $3)`, [
    receiptId,
    tenantId,
    packDigest,
  ])
  await db.query(
    `INSERT INTO projection_artifact
       (tenant_id, artifact_id, store_id, receipt_id, session_id, project_id,
        source_tool, kind, object_id, byte_length, content_type, payload)
       VALUES ($1, 'art_quar', $2, $3, NULL, NULL, 'codex', 'text', $4, $5, 'text/plain', '{}'::jsonb)`,
    [tenantId, storeId, receiptId, objectId, body.length],
  )
}

describe('Lane 8 artifacts/getText — quarantined pack', () => {
  let db: PGlite
  let store: MemoryObjectStore
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    store = new MemoryObjectStore()
    await seedFullChain(db)
    const body = Buffer.from('payload that will be denied because the pack is quarantined', 'utf8')
    await putBytes(store, storageUri, body)
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns the typed data_unavailable shape when the pack is quarantined', async () => {
    // Flip the pack to quarantined.
    await db.query(
      `INSERT INTO pack_audit_state (tenant_id, pack_digest, status, last_audit_at)
         VALUES ($1, $2, 'quarantined', now())`,
      [tenantId, packDigest],
    )

    const seenReasons: ArtifactMissReason[] = []
    const result = await getArtifactText(
      { rawExec: makeRawExec(db), objectStore: store, onMiss: (_t, _id, reason) => seenReasons.push(reason) },
      tenantId,
      { artifactId: 'art_quar', maxBytes: 1024 },
    )
    expect(result.found).toBe(false)
    if (result.found !== false) throw new Error('unreachable')
    expect('reason' in result ? result.reason : '').toBe('data_unavailable')
    expect(seenReasons).toEqual(['pack_quarantined'])
  })

  it('still serves the bytes when the pack is healthy', async () => {
    // No `pack_audit_state` row at all means audit_pending; the route
    // serves bytes normally.
    const result = await getArtifactText({ rawExec: makeRawExec(db), objectStore: store }, tenantId, {
      artifactId: 'art_quar',
      maxBytes: 1024,
    })
    expect(result.found).toBe(true)
    if (!result.found) throw new Error('unreachable')
    expect(result.kind).toBe('text')
  })
})
