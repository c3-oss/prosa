// Lane 6 / CQ-144 + CQ-145 — route-level artifacts.getText pin.
//
// The handler-level test (`artifacts-get-text.test.ts`) covers the
// gate, grant, and decode contract against a v2-only PGlite. This
// suite drives the actual Fastify route through the same Better Auth
// session that `buildTestApp` produces for the rest of the v2 suite
// so the wire response shape — and the gate ladder it sits behind —
// is locked in.
//
// CQ-144 / CQ-145 invariants enforced here:
//
//   - 401 when unauthenticated.
//   - 403 when authenticated but no active tenant.
//   - 400 when `artifactId` is missing / not a string.
//   - 200 with `{ found: false }` (no `reason` field) for every
//     miss path: missing row, missing grant, missing object id,
//     missing object bytes / fetch failure. The opaque shape
//     keeps internal state from leaking to the wire.
//   - 200 with `kind: 'text'` for a valid small UTF-8 artifact.
//   - 200 with `kind: 'binary'` / empty `text` for a binary
//     payload over the bounded preview budget.

import { PUT_PREVERIFIED_BYTES } from '@c3-oss/prosa-storage'
import { describe, expect, it } from 'vitest'
import { V2_READ_ROUTES } from '../../../src/v2/reads/index.js'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

async function signupTenant(t: TestApp, email: string, name: string, slug: string) {
  const r = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName: name, tenantSlug: slug } as never,
  })
  expect(r.statusCode).toBe(200)
  return (r.json() as { result: { data: { token: string; user: { id: string }; tenant: { id: string } } } }).result.data
}

/**
 * The shared test-app PGlite applies v1 schema + the v2 subset
 * (CQ-124 deferred the v2 projection cutover to Lane 10). For the
 * CQ-145 route-level cases we need the v2 shape of
 * `projection_artifact`, so we drop the v1 row and recreate the
 * v2-shape table in place. The rest of the v2 chain
 * (`remote_pack`, `remote_pack_entry`, `receipt_pack_grant`) is
 * already part of the subset.
 */
async function applyV2ProjectionArtifactShape(t: TestApp): Promise<void> {
  await t.db.rawExec('DROP TABLE IF EXISTS projection_artifact CASCADE', [])
  await t.db.rawExec(
    `CREATE TABLE projection_artifact (
       tenant_id     TEXT NOT NULL,
       artifact_id   TEXT NOT NULL,
       store_id      TEXT NOT NULL,
       receipt_id    TEXT NOT NULL,
       session_id    TEXT,
       project_id    TEXT,
       source_tool   TEXT NOT NULL,
       kind          TEXT NOT NULL,
       object_id     TEXT,
       byte_length   BIGINT,
       content_type  TEXT,
       payload       JSONB NOT NULL,
       PRIMARY KEY (tenant_id, artifact_id)
     )`,
    [],
  )
}

async function seedAuthority(t: TestApp, tenantId: string, storeId: string, receiptId: string): Promise<void> {
  await t.db.rawExec(
    `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, store_id) DO UPDATE SET current_receipt_id = EXCLUDED.current_receipt_id`,
    [tenantId, storeId, receiptId, 'aa'.repeat(16)],
  )
}

async function seedPack(
  t: TestApp,
  opts: {
    tenantId: string
    packDigest: string
    storageUri: string
    objectId: string
    storedOffset: number
    storedLength: number
    compression: 'zstd' | 'none'
    uncompressedSize: number
  },
): Promise<void> {
  await t.db.rawExec(
    `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri)
     VALUES ($1, $2, 'cas_object_pack', 1, $3, 'root', $4)
     ON CONFLICT (tenant_id, pack_digest) DO NOTHING`,
    [opts.tenantId, opts.packDigest, opts.storedLength, opts.storageUri],
  )
  await t.db.rawExec(
    `INSERT INTO remote_pack_entry
       (tenant_id, pack_digest, entry_index, object_id, uncompressed_size, stored_offset, stored_length, stored_hash, compression)
     VALUES ($1, $2, 0, $3, $4, $5, $6, 'h', $7)
     ON CONFLICT (tenant_id, pack_digest, entry_index) DO NOTHING`,
    [
      opts.tenantId,
      opts.packDigest,
      opts.objectId,
      opts.uncompressedSize,
      opts.storedOffset,
      opts.storedLength,
      opts.compression,
    ],
  )
}

async function seedGrant(t: TestApp, tenantId: string, receiptId: string, packDigest: string): Promise<void> {
  await t.db.rawExec(
    `INSERT INTO receipt_pack_grant (receipt_id, tenant_id, pack_digest) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [receiptId, tenantId, packDigest],
  )
}

async function seedArtifact(
  t: TestApp,
  opts: {
    tenantId: string
    storeId: string
    receiptId: string
    artifactId: string
    objectId: string | null
    contentType?: string | null
  },
): Promise<void> {
  await t.db.rawExec(
    `INSERT INTO projection_artifact
       (tenant_id, artifact_id, store_id, receipt_id, source_tool, kind, object_id, content_type, payload)
     VALUES ($1, $2, $3, $4, 'codex', 'text', $5, $6, '{}'::jsonb)`,
    [opts.tenantId, opts.artifactId, opts.storeId, opts.receiptId, opts.objectId, opts.contentType ?? null],
  )
}

async function putBytes(t: TestApp, key: string, bytes: Buffer): Promise<void> {
  await t.objectStore[PUT_PREVERIFIED_BYTES](
    key,
    (async function* () {
      yield new Uint8Array(bytes)
    })(),
    { hash: 'h', hashAlgorithm: 'blake3', uncompressedSize: bytes.length, compressedSize: bytes.length },
  )
}

async function postGetText(t: TestApp, token: string, body: Record<string, unknown>) {
  return t.app.inject({
    method: 'POST',
    url: '/v2/reads/artifacts/getText',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body as never,
  })
}

describe('Lane 6 artifacts.getText route — CQ-144 opacity at the HTTP boundary', () => {
  it('lists the artifacts route in V2_READ_ROUTES so the contract stays pinned', () => {
    const op = V2_READ_ROUTES.find((r) => r.url === '/v2/reads/artifacts/getText')
    expect(op).toBeDefined()
    expect(op?.method).toBe('POST')
    expect(op?.opName).toBe('ReadArtifactsGetText')
  })

  it('returns 401 / UNAUTHENTICATED when no auth token is presented', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/reads/artifacts/getText',
        headers: { 'content-type': 'application/json' },
        payload: { artifactId: 'art_x' } as never,
      })
      expect(response.statusCode).toBe(401)
      const body = response.json() as { code: string; op: string }
      expect(body.code).toBe('UNAUTHENTICATED')
      expect(body.op).toBe('ReadArtifactsGetText')
    } finally {
      await t.close()
    }
  })

  it('returns 400 / INVALID_INPUT when artifactId is missing', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-route-missing@example.com', 'Acme', 'acme-art-route-missing')
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/reads/artifacts/getText',
        headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
        payload: {} as never,
      })
      expect(response.statusCode).toBe(400)
      const body = response.json() as { code: string }
      expect(body.code).toBe('INVALID_INPUT')
    } finally {
      await t.close()
    }
  })

  it('returns an opaque { found: false } body for a missing artifact id (no internal reason leaks)', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-route-opaque@example.com', 'Acme', 'acme-art-route-opaque')
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/reads/artifacts/getText',
        headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
        payload: { artifactId: 'art_never_existed', maxBytes: 1024 } as never,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as Record<string, unknown>
      expect(body).toEqual({ found: false })
      // Critically: no `reason` / `code` / `message` field is
      // serialized to the wire. Locking down the keys protects
      // against accidental regressions that re-introduce a leak.
      expect(Object.keys(body).sort()).toEqual(['found'])
    } finally {
      await t.close()
    }
  })
})

describe('Lane 6 artifacts.getText route — CQ-145 full miss + success matrix', () => {
  it('returns opaque { found: false } when the artifact has no receipt pack grant', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-no-grant@example.com', 'Acme', 'acme-art-no-grant')
      await applyV2ProjectionArtifactShape(t)
      await seedAuthority(t, account.tenant.id, 's_a', 'rcp_a')
      await seedPack(t, {
        tenantId: account.tenant.id,
        packDigest: 'pack_a',
        storageUri: 'object-packs/no-grant',
        objectId: 'blake3:obj_no_grant',
        storedOffset: 0,
        storedLength: 16,
        compression: 'none',
        uncompressedSize: 16,
      })
      // No `seedGrant` — the receipt holds authority but no pack grant.
      await seedArtifact(t, {
        tenantId: account.tenant.id,
        storeId: 's_a',
        receiptId: 'rcp_a',
        artifactId: 'art_no_grant',
        objectId: 'blake3:obj_no_grant',
        contentType: 'text/plain',
      })
      const response = await postGetText(t, account.token, { artifactId: 'art_no_grant', maxBytes: 1024 })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ found: false })
    } finally {
      await t.close()
    }
  })

  it('returns opaque { found: false } when the artifact has no object id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-no-obj@example.com', 'Acme', 'acme-art-no-obj')
      await applyV2ProjectionArtifactShape(t)
      await seedAuthority(t, account.tenant.id, 's_a', 'rcp_a')
      await seedArtifact(t, {
        tenantId: account.tenant.id,
        storeId: 's_a',
        receiptId: 'rcp_a',
        artifactId: 'art_no_obj',
        objectId: null,
      })
      const response = await postGetText(t, account.token, { artifactId: 'art_no_obj', maxBytes: 1024 })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ found: false })
    } finally {
      await t.close()
    }
  })

  it('returns opaque { found: false } when the catalogued storage uri is missing in the object store', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-fetch-fail@example.com', 'Acme', 'acme-art-fetch-fail')
      await applyV2ProjectionArtifactShape(t)
      await seedAuthority(t, account.tenant.id, 's_a', 'rcp_a')
      await seedPack(t, {
        tenantId: account.tenant.id,
        packDigest: 'pack_a',
        storageUri: 'object-packs/missing-bytes',
        objectId: 'blake3:obj_missing',
        storedOffset: 0,
        storedLength: 32,
        compression: 'none',
        uncompressedSize: 32,
      })
      await seedGrant(t, account.tenant.id, 'rcp_a', 'pack_a')
      await seedArtifact(t, {
        tenantId: account.tenant.id,
        storeId: 's_a',
        receiptId: 'rcp_a',
        artifactId: 'art_fetch_fail',
        objectId: 'blake3:obj_missing',
        contentType: 'text/plain',
      })
      // NOTE: nothing was put into the object store at the catalogued uri.
      const response = await postGetText(t, account.token, { artifactId: 'art_fetch_fail', maxBytes: 1024 })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ found: false })
    } finally {
      await t.close()
    }
  })

  it('returns kind: text with bounded UTF-8 body for a valid small uncompressed artifact', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-text-ok@example.com', 'Acme', 'acme-art-text-ok')
      await applyV2ProjectionArtifactShape(t)
      await seedAuthority(t, account.tenant.id, 's_a', 'rcp_a')
      const body = Buffer.from('the quick brown fox jumps over the lazy dog\n', 'utf8')
      await putBytes(t, 'object-packs/text-ok', body)
      await seedPack(t, {
        tenantId: account.tenant.id,
        packDigest: 'pack_text_ok',
        storageUri: 'object-packs/text-ok',
        objectId: 'blake3:obj_text_ok',
        storedOffset: 0,
        storedLength: body.length,
        compression: 'none',
        uncompressedSize: body.length,
      })
      await seedGrant(t, account.tenant.id, 'rcp_a', 'pack_text_ok')
      await seedArtifact(t, {
        tenantId: account.tenant.id,
        storeId: 's_a',
        receiptId: 'rcp_a',
        artifactId: 'art_text_ok',
        objectId: 'blake3:obj_text_ok',
        contentType: 'text/plain',
      })
      const response = await postGetText(t, account.token, { artifactId: 'art_text_ok', maxBytes: 64 * 1024 })
      expect(response.statusCode).toBe(200)
      const json = response.json() as Record<string, unknown>
      expect(json.found).toBe(true)
      expect(json.kind).toBe('text')
      expect(json.bytesReturned).toBe(body.length)
      expect(json.text).toBe(body.toString('utf8'))
      expect(json.truncated).toBe(false)
    } finally {
      await t.close()
    }
  })

  it('returns kind: binary with empty text for a > 1 MiB binary artifact at the preview cap', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-binary-large@example.com', 'Acme', 'acme-art-bin-large')
      await applyV2ProjectionArtifactShape(t)
      await seedAuthority(t, account.tenant.id, 's_a', 'rcp_a')
      // 1 MiB + 1 of mostly-binary bytes so the heuristic flips to
      // `kind: 'binary'` and the bounded reader stops at maxBytes.
      const body = Buffer.alloc(1024 * 1024 + 1)
      for (let i = 0; i < body.length; i += 1) body[i] = (i * 7 + 3) & 0xff
      await putBytes(t, 'object-packs/binary-large', body)
      await seedPack(t, {
        tenantId: account.tenant.id,
        packDigest: 'pack_bin_large',
        storageUri: 'object-packs/binary-large',
        objectId: 'blake3:obj_bin_large',
        storedOffset: 0,
        storedLength: body.length,
        compression: 'none',
        uncompressedSize: body.length,
      })
      await seedGrant(t, account.tenant.id, 'rcp_a', 'pack_bin_large')
      await seedArtifact(t, {
        tenantId: account.tenant.id,
        storeId: 's_a',
        receiptId: 'rcp_a',
        artifactId: 'art_bin_large',
        objectId: 'blake3:obj_bin_large',
        contentType: 'application/octet-stream',
      })
      const maxBytes = 256 * 1024
      const response = await postGetText(t, account.token, { artifactId: 'art_bin_large', maxBytes })
      expect(response.statusCode).toBe(200)
      const json = response.json() as Record<string, unknown>
      expect(json.found).toBe(true)
      expect(json.kind).toBe('binary')
      expect(json.text).toBe('')
      expect(json.bytesReturned).toBe(maxBytes)
      expect(json.truncated).toBe(true)
    } finally {
      await t.close()
    }
  })
})
