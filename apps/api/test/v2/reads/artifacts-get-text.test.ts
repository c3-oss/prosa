// Lane 6 — artifacts/getText pin.
//
// The handler enforces a four-step gate before any bytes leave the
// process:
//
//   1. Verified-projection gate on `projection_artifact`.
//   2. `receipt_pack_grant` exists for the artifact's receipt and
//      the pack that contains the underlying object.
//   3. `remote_pack_entry` + `remote_pack` resolve the storage
//      key, offset, length, compression.
//   4. Bounded byte fetch via the object store; zstd-compressed
//      entries decompress through `decompressZstdBounded`.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore, PUT_PREVERIFIED_BYTES } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ArtifactMissReason, getArtifactText } from '../../../src/v2/reads/artifacts/get-text.js'

async function putBytes(store: MemoryObjectStore, key: string, bytes: Buffer): Promise<void> {
  // Bypass the hash verification — these tests do not exercise the
  // hash invariant (covered by the upload tests); they exercise
  // the projection / grant / pack / object resolution chain.
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

async function seedAuthority(
  db: PGlite,
  rows: Array<{ tenantId: string; storeId: string; receiptId: string }>,
): Promise<void> {
  for (const r of rows) {
    await db.query(
      `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, store_id) DO UPDATE SET current_receipt_id = EXCLUDED.current_receipt_id`,
      [r.tenantId, r.storeId, r.receiptId, 'aa'.repeat(16)],
    )
  }
}

async function seedPack(
  db: PGlite,
  opts: {
    tenantId: string
    packDigest: string
    storageUri: string
    byteLength: number
    entryCount: number
    objectId: string
    storedOffset: number
    storedLength: number
    storedHash: string
    compression: 'zstd' | 'none'
    uncompressedSize: number
  },
) {
  await db.query(
    `INSERT INTO remote_pack
       (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri)
     VALUES ($1, $2, 'cas_object_pack', $3, $4, $5, $6)`,
    [opts.tenantId, opts.packDigest, opts.entryCount, opts.byteLength, 'root', opts.storageUri],
  )
  await db.query(
    `INSERT INTO remote_pack_entry
       (tenant_id, pack_digest, entry_index, object_id, uncompressed_size, stored_offset, stored_length, stored_hash, compression)
     VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8)`,
    [
      opts.tenantId,
      opts.packDigest,
      opts.objectId,
      opts.uncompressedSize,
      opts.storedOffset,
      opts.storedLength,
      opts.storedHash,
      opts.compression,
    ],
  )
}

async function seedGrant(db: PGlite, opts: { tenantId: string; receiptId: string; packDigest: string }) {
  await db.query(
    `INSERT INTO receipt_pack_grant (receipt_id, tenant_id, pack_digest)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [opts.receiptId, opts.tenantId, opts.packDigest],
  )
}

async function seedArtifact(
  db: PGlite,
  opts: {
    tenantId: string
    storeId: string
    receiptId: string
    artifactId: string
    sessionId?: string | null
    sourceTool?: string
    kind?: string
    objectId: string | null
    byteLength?: number | null
    contentType?: string | null
  },
) {
  await db.query(
    `INSERT INTO projection_artifact
       (tenant_id, artifact_id, store_id, receipt_id, session_id, project_id,
        source_tool, kind, object_id, byte_length, content_type, payload)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, '{}'::jsonb)`,
    [
      opts.tenantId,
      opts.artifactId,
      opts.storeId,
      opts.receiptId,
      opts.sessionId ?? null,
      opts.sourceTool ?? 'codex',
      opts.kind ?? 'text',
      opts.objectId,
      opts.byteLength ?? null,
      opts.contentType ?? null,
    ],
  )
}

const tenantId = 't_a'
const storeId = 's_a'
const receiptId = 'rcp_a'
const packDigest = 'pack_a'
const storageUri = 'object-packs/t_a/batch_a/pack_a.pack'
const objectId = 'blake3:cafebabe'

describe('Lane 6 artifacts/getText', () => {
  let db: PGlite
  let store: MemoryObjectStore
  beforeEach(async () => {
    db = new PGlite()
    await applySchemaV2(db)
    await seedAuthority(db, [{ tenantId, storeId, receiptId }])
    store = new MemoryObjectStore()
  })
  afterEach(async () => {
    await db.close()
  })

  it('returns an opaque { found: false } when the artifact is missing or under a superseded receipt (CQ-144)', async () => {
    const seenReasons: ArtifactMissReason[] = []
    const onMiss = (_t: string, _id: string, reason: ArtifactMissReason) => {
      seenReasons.push(reason)
    }
    const miss = await getArtifactText({ rawExec: makeRawExec(db), objectStore: store, onMiss }, tenantId, {
      artifactId: 'art_missing',
      maxBytes: 1024,
    })
    expect(miss).toEqual({ found: false })

    await seedArtifact(db, {
      tenantId,
      storeId,
      receiptId: 'rcp_superseded',
      artifactId: 'art_super',
      objectId,
    })
    const superseded = await getArtifactText({ rawExec: makeRawExec(db), objectStore: store, onMiss }, tenantId, {
      artifactId: 'art_super',
      maxBytes: 1024,
    })
    expect(superseded).toEqual({ found: false })
    // Internal observability hook still sees the real reason — but the
    // caller-visible shape is opaque.
    expect(seenReasons).toEqual(['not_visible', 'not_visible'])
  })

  it('returns an opaque { found: false } when the receipt does not own the pack — onMiss observes no_grant', async () => {
    const seenReasons: ArtifactMissReason[] = []
    await seedPack(db, {
      tenantId,
      packDigest,
      storageUri,
      byteLength: 100,
      entryCount: 1,
      objectId,
      storedOffset: 0,
      storedLength: 100,
      storedHash: 'h',
      compression: 'none',
      uncompressedSize: 100,
    })
    // NO grant inserted — the receipt has authority but no pack grant.
    await seedArtifact(db, {
      tenantId,
      storeId,
      receiptId,
      artifactId: 'art_no_grant',
      objectId,
    })
    const r = await getArtifactText(
      {
        rawExec: makeRawExec(db),
        objectStore: store,
        onMiss: (_t, _id, reason) => seenReasons.push(reason),
      },
      tenantId,
      { artifactId: 'art_no_grant', maxBytes: 1024 },
    )
    expect(r).toEqual({ found: false })
    expect(seenReasons).toEqual(['no_grant'])
  })

  it('returns an opaque { found: false } when the artifact has no object id — onMiss observes no_object', async () => {
    const seenReasons: ArtifactMissReason[] = []
    await seedArtifact(db, { tenantId, storeId, receiptId, artifactId: 'art_no_obj', objectId: null })
    const r = await getArtifactText(
      {
        rawExec: makeRawExec(db),
        objectStore: store,
        onMiss: (_t, _id, reason) => seenReasons.push(reason),
      },
      tenantId,
      { artifactId: 'art_no_obj', maxBytes: 1024 },
    )
    expect(r).toEqual({ found: false })
    expect(seenReasons).toEqual(['no_object'])
  })

  it('returns an opaque { found: false } when the object bytes cannot be fetched — onMiss observes fetch_failed', async () => {
    // Catalog row points to a storage URI that does not exist in the
    // object store.
    await seedPack(db, {
      tenantId,
      packDigest,
      storageUri: 'object-packs/missing-bytes',
      byteLength: 100,
      entryCount: 1,
      objectId,
      storedOffset: 0,
      storedLength: 100,
      storedHash: 'h',
      compression: 'none',
      uncompressedSize: 100,
    })
    await seedGrant(db, { tenantId, receiptId, packDigest })
    await seedArtifact(db, {
      tenantId,
      storeId,
      receiptId,
      artifactId: 'art_fetch_fail',
      objectId,
    })
    const seenReasons: ArtifactMissReason[] = []
    const r = await getArtifactText(
      {
        rawExec: makeRawExec(db),
        objectStore: store,
        onMiss: (_t, _id, reason) => seenReasons.push(reason),
      },
      tenantId,
      { artifactId: 'art_fetch_fail', maxBytes: 1024 },
    )
    expect(r).toEqual({ found: false })
    expect(seenReasons).toEqual(['fetch_failed'])
  })

  it('fetches and returns bounded UTF-8 text for an uncompressed object', async () => {
    const body = Buffer.from('the quick brown fox jumps over the lazy dog\n', 'utf8')
    // Put the full pack file at the storage uri (just the body for
    // simplicity — `stored_offset` 0 / `stored_length` body.length).
    await putBytes(store, storageUri, body)
    await seedPack(db, {
      tenantId,
      packDigest,
      storageUri,
      byteLength: body.length,
      entryCount: 1,
      objectId,
      storedOffset: 0,
      storedLength: body.length,
      storedHash: 'h',
      compression: 'none',
      uncompressedSize: body.length,
    })
    await seedGrant(db, { tenantId, receiptId, packDigest })
    await seedArtifact(db, {
      tenantId,
      storeId,
      receiptId,
      artifactId: 'art_ok',
      objectId,
      byteLength: body.length,
      contentType: 'text/plain',
    })

    const r = await getArtifactText({ rawExec: makeRawExec(db), objectStore: store }, tenantId, {
      artifactId: 'art_ok',
      maxBytes: 64 * 1024,
    })
    expect(r.found).toBe(true)
    if (!r.found) throw new Error('expected found')
    expect(r.kind).toBe('text')
    expect(r.bytesReturned).toBe(body.length)
    expect(r.text).toBe(body.toString('utf8'))
    expect(r.truncated).toBe(false)
    expect(r.storeId).toBe(storeId)
    expect(r.receiptId).toBe(receiptId)
  })

  it('truncates oversize text at maxBytes', async () => {
    const body = Buffer.from('x'.repeat(2048), 'utf8')
    await putBytes(store, storageUri, body)
    await seedPack(db, {
      tenantId,
      packDigest,
      storageUri,
      byteLength: body.length,
      entryCount: 1,
      objectId,
      storedOffset: 0,
      storedLength: body.length,
      storedHash: 'h',
      compression: 'none',
      uncompressedSize: body.length,
    })
    await seedGrant(db, { tenantId, receiptId, packDigest })
    await seedArtifact(db, {
      tenantId,
      storeId,
      receiptId,
      artifactId: 'art_big',
      objectId,
      contentType: 'text/plain',
    })
    const r = await getArtifactText({ rawExec: makeRawExec(db), objectStore: store }, tenantId, {
      artifactId: 'art_big',
      maxBytes: 1024,
    })
    if (!r.found) throw new Error('expected found')
    expect(r.bytesReturned).toBe(1024)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(1024)
  })

  it('returns kind: binary with empty text for non-text bytes', async () => {
    const body = Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x00, 0xfa, 0xfb])
    await putBytes(store, storageUri, body)
    await seedPack(db, {
      tenantId,
      packDigest,
      storageUri,
      byteLength: body.length,
      entryCount: 1,
      objectId,
      storedOffset: 0,
      storedLength: body.length,
      storedHash: 'h',
      compression: 'none',
      uncompressedSize: body.length,
    })
    await seedGrant(db, { tenantId, receiptId, packDigest })
    await seedArtifact(db, {
      tenantId,
      storeId,
      receiptId,
      artifactId: 'art_bin',
      objectId,
      contentType: 'application/octet-stream',
    })
    const r = await getArtifactText({ rawExec: makeRawExec(db), objectStore: store }, tenantId, {
      artifactId: 'art_bin',
      maxBytes: 1024,
    })
    if (!r.found) throw new Error('expected found')
    expect(r.kind).toBe('binary')
    expect(r.text).toBe('')
    expect(r.bytesReturned).toBe(body.length)
  })

  it('does not leak another tenants artifact even with the same artifact id', async () => {
    const bob = 't_bob'
    const bobStore = 's_bob'
    const bobReceipt = 'rcp_bob'
    await seedAuthority(db, [{ tenantId: bob, storeId: bobStore, receiptId: bobReceipt }])

    const body = Buffer.from('alice-private', 'utf8')
    await putBytes(store, 'object-packs/alice-only', body)
    await seedPack(db, {
      tenantId,
      packDigest: 'pack_alice',
      storageUri: 'object-packs/alice-only',
      byteLength: body.length,
      entryCount: 1,
      objectId,
      storedOffset: 0,
      storedLength: body.length,
      storedHash: 'h',
      compression: 'none',
      uncompressedSize: body.length,
    })
    await seedGrant(db, { tenantId, receiptId, packDigest: 'pack_alice' })
    await seedArtifact(db, {
      tenantId,
      storeId,
      receiptId,
      artifactId: 'art_shared',
      objectId,
      contentType: 'text/plain',
    })

    // Bob asks for `art_shared` — must be invisible.
    const bobRequest = await getArtifactText({ rawExec: makeRawExec(db), objectStore: store }, bob, {
      artifactId: 'art_shared',
      maxBytes: 1024,
    })
    expect(bobRequest.found).toBe(false)
  })
})
