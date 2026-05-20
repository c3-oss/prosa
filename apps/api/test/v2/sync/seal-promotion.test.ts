// Lane 5 slice 5 — POST /v2/promotions/:promotionId/seal.
//
// End-to-end happy path drives a full BeginPromotion → upload
// inventories → upload object pack → seal sequence and asserts that
// exactly one receipt row, one remote_authority_v2 row, one
// search_generation_current row, and N receipt_pack_grant rows are
// written. The seal is idempotent: a second seal call returns the
// same receipt without inserting duplicates.
//
// Additional cases pin: unauth 401, unknown promotion 404,
// cross-tenant 404 (I1), missing inventories → 409 INVENTORY_INCOMPLETE,
// signature verifies against the published JWKS (invariant I5).

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

const BEGIN_URL = '/v2/promotions/begin'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}

async function signupWithTenant(t: TestApp, email: string, tenantName: string, tenantSlug: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName, tenantSlug } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: { data: { token: string; user: { id: string }; tenant: { id: string } } }
    }
  ).result.data
}

// Build a real CAS pack + corresponding inventory segments. The
// inventory segments here are not the real Arrow-encoded format —
// they're opaque bytes whose BLAKE3 we use as the declared segment
// `digest`. That's enough to exercise the upload + seal contracts,
// which only care about (length, blake3) on inventory bytes.
function buildPromotionFixture() {
  const pack = buildCasPack(
    [
      { bytes: new TextEncoder().encode('alpha-object-payload'), compression: 'zstd' },
      { bytes: new TextEncoder().encode('bravo-object-payload'), compression: 'zstd' },
    ],
    { createdAt: '2026-05-20T00:00:00.000Z' },
  )
  const objectInventoryBytes = new TextEncoder().encode('opaque-object-inventory-arrow-zst')
  const projectionInventoryBytes = new TextEncoder().encode('opaque-projection-inventory-arrow-zst')
  const objectInventoryDigest = transportHashOf(objectInventoryBytes)
  const projectionInventoryDigest = transportHashOf(projectionInventoryBytes)
  return {
    pack,
    objectInventoryBytes,
    projectionInventoryBytes,
    objectInventoryDigest,
    projectionInventoryDigest,
  }
}

function buildBeginBody(opts: {
  tenantId: string
  storeId?: string
  bundleRoot?: string
  objectInventory: { segmentId: string; digest: string; byteLength: number }
  projectionInventory: { segmentId: string; digest: string; byteLength: number }
}) {
  const storeId = opts.storeId ?? 'store-seal'
  const bundleRoot = opts.bundleRoot ?? '99'.repeat(32)
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId,
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId,
      storePath: '/home/test/store',
      epoch: 0,
      parserVersion: '0.1.0',
      createdAt: '2026-05-20T00:00:00.000Z',
      previousBundleRoot: null,
      bundleRoot,
      rawSourceRoot: 'ee'.repeat(32),
      manifestDigest: `blake3:${'ff'.repeat(32)}`,
      counts: {
        sourceFiles: 0,
        rawRecords: 0,
        objects: 2,
        sessions: 1,
        messages: 1,
        events: 0,
        contentBlocks: 0,
        turns: 0,
        toolCalls: 0,
        toolResults: 0,
        artifacts: 0,
        edges: 0,
        searchDocs: 1,
        projectionRows: 2,
      },
      segments: [],
    },
    inventories: {
      objectInventorySegment: {
        segmentId: opts.objectInventory.segmentId,
        kind: 'inventory_object',
        digest: opts.objectInventory.digest,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: opts.objectInventory.byteLength,
      },
      projectionInventorySegment: {
        segmentId: opts.projectionInventory.segmentId,
        kind: 'inventory_projection',
        digest: opts.projectionInventory.digest,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: opts.projectionInventory.byteLength,
      },
    },
    device: { deviceId: 'dev-seal' },
  }
}

async function drivePromotion(t: TestApp, token: string, tenantId: string, opts: { bundleRoot?: string } = {}) {
  const fx = buildPromotionFixture()
  const begin = await t.app.inject({
    method: 'POST',
    url: BEGIN_URL,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: buildBeginBody({
      tenantId,
      bundleRoot: opts.bundleRoot,
      objectInventory: {
        segmentId: 'seg-obj-inv',
        digest: fx.objectInventoryDigest,
        byteLength: fx.objectInventoryBytes.byteLength,
      },
      projectionInventory: {
        segmentId: 'seg-proj-inv',
        digest: fx.projectionInventoryDigest,
        byteLength: fx.projectionInventoryBytes.byteLength,
      },
    }) as never,
  })
  expect(begin.statusCode).toBe(200)
  const { promotionId } = begin.json() as { promotionId: string }

  const upObj = await t.app.inject({
    method: 'PUT',
    url: `/v2/promotions/${promotionId}/segments/seg-obj-inv`,
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    payload: Buffer.from(fx.objectInventoryBytes),
  })
  expect(upObj.statusCode).toBe(200)
  const upProj = await t.app.inject({
    method: 'PUT',
    url: `/v2/promotions/${promotionId}/segments/seg-proj-inv`,
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    payload: Buffer.from(fx.projectionInventoryBytes),
  })
  expect(upProj.statusCode).toBe(200)

  const upPack = await t.app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/object-packs`,
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    payload: Buffer.from(fx.pack.bytes),
  })
  expect(upPack.statusCode).toBe(200)

  return { promotionId, fx }
}

describe('POST /v2/promotions/:promotionId/seal — Lane 5 slice 5', () => {
  it('returns 401 to unauthenticated callers', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/prm_x/seal',
        headers: { 'content-type': 'application/json' },
        payload: {} as never,
      })
      expect(response.statusCode).toBe(401)
      expect((response.json() as { code: string }).code).toBe('UNAUTHENTICATED')
    } finally {
      await t.close()
    }
  })

  it('returns 404 PROMOTION_NOT_FOUND for an unknown promotion id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'seal-404@example.com', 'Acme', 'acme-seal-404')
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/prm_unknown00000000000000000000/seal',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: {} as never,
      })
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('returns 409 INVENTORY_INCOMPLETE when inventories were never uploaded', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'seal-inv@example.com', 'Acme', 'acme-seal-inv')
      const fx = buildPromotionFixture()
      const begin = await t.app.inject({
        method: 'POST',
        url: BEGIN_URL,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          objectInventory: {
            segmentId: 'seg-obj-inv',
            digest: fx.objectInventoryDigest,
            byteLength: fx.objectInventoryBytes.byteLength,
          },
          projectionInventory: {
            segmentId: 'seg-proj-inv',
            digest: fx.projectionInventoryDigest,
            byteLength: fx.projectionInventoryBytes.byteLength,
          },
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }
      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: {} as never,
      })
      expect(seal.statusCode).toBe(409)
      const body = seal.json() as { code: string; missingSegmentIds: string[] }
      expect(body.code).toBe('INVENTORY_INCOMPLETE')
      expect(body.missingSegmentIds).toEqual(expect.arrayContaining(['seg-obj-inv', 'seg-proj-inv']))
    } finally {
      await t.close()
    }
  })

  it('seals successfully and writes receipt + authority + grants in one transaction', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'seal-ok@example.com', 'Acme', 'acme-seal-ok')
      const { promotionId, fx } = await drivePromotion(t, account.token, account.tenant.id)

      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: {} as never,
      })
      expect(seal.statusCode).toBe(200)
      const body = seal.json() as {
        status: string
        receipt: {
          payload: { receiptId: string; bundleRoot: string; tenantId: string }
          signature: { alg: string; keyId: string; sig: string }
        }
      }
      expect(body.status).toBe('sealed')
      expect(body.receipt.payload.bundleRoot).toBe('99'.repeat(32))
      expect(body.receipt.signature.alg).toBe('Ed25519')

      // Row assertions.
      const receiptRows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM receipt WHERE tenant_id = $1 AND receipt_id = $2`,
        [account.tenant.id, body.receipt.payload.receiptId],
      )
      expect(Number(receiptRows[0]!.count)).toBe(1)

      const authorityRows = await t.db.rawExec<{ current_receipt_id: string; current_bundle_root: string }>(
        `SELECT current_receipt_id, current_bundle_root FROM remote_authority_v2 WHERE tenant_id = $1`,
        [account.tenant.id],
      )
      expect(authorityRows.length).toBe(1)
      expect(authorityRows[0]!.current_receipt_id).toBe(body.receipt.payload.receiptId)
      expect(authorityRows[0]!.current_bundle_root).toBe('99'.repeat(32))

      const generationRows = await t.db.rawExec<{ receipt_id: string }>(
        `SELECT receipt_id FROM search_generation_current WHERE tenant_id = $1`,
        [account.tenant.id],
      )
      expect(generationRows[0]?.receipt_id).toBe(body.receipt.payload.receiptId)

      const grantRows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM receipt_pack_grant WHERE receipt_id = $1`,
        [body.receipt.payload.receiptId],
      )
      expect(Number(grantRows[0]!.count)).toBe(1)
      const grantDigest = await t.db.rawExec<{ pack_digest: string }>(
        `SELECT pack_digest FROM receipt_pack_grant WHERE receipt_id = $1`,
        [body.receipt.payload.receiptId],
      )
      expect(grantDigest[0]!.pack_digest).toBe(fx.pack.packDigest)

      const stagingStatus = await t.db.rawExec<{ status: string }>(
        `SELECT status FROM promotion_staging WHERE id = $1`,
        [promotionId],
      )
      expect(stagingStatus[0]!.status).toBe('sealed')
    } finally {
      await t.close()
    }
  })

  it('is idempotent: re-sealing returns the same receipt without duplicating rows', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'seal-idem@example.com', 'Acme', 'acme-seal-idem')
      const { promotionId } = await drivePromotion(t, account.token, account.tenant.id)

      const first = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: {} as never,
      })
      expect(first.statusCode).toBe(200)
      const firstReceiptId = (first.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload.receiptId

      const second = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: {} as never,
      })
      expect(second.statusCode).toBe(200)
      const secondReceiptId = (second.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload
        .receiptId
      expect(secondReceiptId).toBe(firstReceiptId)

      // Receipt and grant rows are not duplicated.
      const receiptRows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM receipt WHERE tenant_id = $1`,
        [account.tenant.id],
      )
      expect(Number(receiptRows[0]!.count)).toBe(1)
      const grantRows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM receipt_pack_grant WHERE receipt_id = $1`,
        [firstReceiptId],
      )
      expect(Number(grantRows[0]!.count)).toBe(1)
    } finally {
      await t.close()
    }
  })

  it('does not leak promotion ownership across tenants (I1) on seal', async () => {
    const t = await buildTestApp()
    try {
      const accountA = await signupWithTenant(t, 'seal-iso-a@example.com', 'Acme A', 'acme-seal-iso-a')
      const accountB = await signupWithTenant(t, 'seal-iso-b@example.com', 'Acme B', 'acme-seal-iso-b')
      const { promotionId } = await drivePromotion(t, accountA.token, accountA.tenant.id)
      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accountB.token}` },
        payload: {} as never,
      })
      expect(seal.statusCode).toBe(404)
      expect((seal.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('produces a receipt whose signature verifies against the published JWKS (I5)', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'seal-i5@example.com', 'Acme', 'acme-seal-i5')
      const { promotionId } = await drivePromotion(t, account.token, account.tenant.id)
      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: {} as never,
      })
      const body = seal.json() as {
        receipt: { payload: Record<string, unknown>; signature: { keyId: string; sig: string } }
      }

      const jwksResponse = await t.app.inject({ method: 'GET', url: '/v2/.well-known/receipt-keys.json' })
      expect(jwksResponse.statusCode).toBe(200)
      const jwks = jwksResponse.json() as {
        keys: Array<{ kty: string; crv: string; x: string; kid: string }>
      }
      const key = jwks.keys.find((k) => k.kid === body.receipt.signature.keyId)
      expect(key).toBeDefined()

      // Verify the signature with node:crypto against the published JWK.
      const { createPublicKey, verify } = await import('node:crypto')
      const publicKey = createPublicKey({ key: { ...key!, alg: 'EdDSA' } as never, format: 'jwk' })
      const { receiptPayloadBytes } = await import('@c3-oss/prosa-types-v2')
      const payloadBytes = receiptPayloadBytes(body.receipt.payload as never)
      const sigBytes = Buffer.from(body.receipt.signature.sig, 'base64url')
      const ok = verify(null, payloadBytes, publicKey, sigBytes)
      expect(ok).toBe(true)
    } finally {
      await t.close()
    }
  })
})
