// CQ-136 (linked-receipt validation): the sealed-replay path —
// both the `status='sealed'` branch AND the race-loser branch
// where another seal flipped the row past us — must validate
// the linked receipt's content-addressed derived id AND its
// Ed25519 signature against the server JWKS before returning it.
// The earlier tuple-only closure still let a same-tenant attacker
// who tampered with the JSONB payload (breaking the canonical
// hash) or swapped in a bogus signature get a corrupt receipt
// back through replay.
//
// We seal a real promotion to establish a valid (staging,
// sealed_receipt_id, receipt) link, then point the staging row
// at a same-tenant SPOOF receipt that passes the tuple check but
// fails one of (deriveReceiptId, signature). The route must
// throw `SealPromotionLinkCorruptError` → 500 SEAL_LINK_CORRUPT.

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { deriveReceiptId, receiptPayloadBytes } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}

async function signupTenant(t: TestApp, email: string, name: string, slug: string) {
  const r = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName: name, tenantSlug: slug } as never,
  })
  expect(r.statusCode).toBe(200)
  return (r.json() as { result: { data: { token: string; tenant: { id: string } } } }).result.data
}

function buildFixture(label: string) {
  const objBytes = new TextEncoder().encode(`${label}-obj-inv`)
  const projBytes = new TextEncoder().encode(`${label}-proj-inv`)
  const pack = buildCasPack([{ bytes: new TextEncoder().encode(`${label}-payload`), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })
  return {
    pack,
    objBytes,
    projBytes,
    objDigest: transportHashOf(objBytes),
    projDigest: transportHashOf(projBytes),
  }
}

function buildBeginBody(opts: {
  tenantId: string
  storeId: string
  bundleRoot: string
  declaredObjectCount: number
  fx: ReturnType<typeof buildFixture>
}) {
  const { fx } = opts
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId: opts.storeId,
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId: opts.storeId,
      storePath: '/home/test/store',
      epoch: 0,
      parserVersion: '0.1.0',
      createdAt: '2026-05-20T00:00:00.000Z',
      previousBundleRoot: null,
      bundleRoot: opts.bundleRoot,
      rawSourceRoot: '11'.repeat(32),
      manifestDigest: `blake3:${'22'.repeat(32)}`,
      counts: {
        sourceFiles: 0,
        rawRecords: 0,
        objects: opts.declaredObjectCount,
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
        segmentId: `${opts.storeId}-obj`,
        kind: 'inventory_object',
        digest: fx.objDigest,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: fx.objBytes.byteLength,
      },
      projectionInventorySegment: {
        segmentId: `${opts.storeId}-proj`,
        kind: 'inventory_projection',
        digest: fx.projDigest,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: fx.projBytes.byteLength,
      },
    },
    device: { deviceId: `${opts.storeId}-dev` },
  }
}

async function drivePromotionThroughUploads(
  t: TestApp,
  token: string,
  body: ReturnType<typeof buildBeginBody>,
  fx: ReturnType<typeof buildFixture>,
): Promise<{ promotionId: string }> {
  const begin = await t.app.inject({
    method: 'POST',
    url: '/v2/promotions/begin',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: body as never,
  })
  expect(begin.statusCode).toBe(200)
  const beginBody = begin.json() as { promotionId: string }
  const promotionId = beginBody.promotionId
  const deviceId = body.device.deviceId
  await t.app.inject({
    method: 'PUT',
    url: `/v2/promotions/${promotionId}/segments/${body.inventories.objectInventorySegment.segmentId}`,
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-prosa-transport-hash': fx.objDigest,
      'x-prosa-device-id': deviceId,
    },
    payload: Buffer.from(fx.objBytes),
  })
  await t.app.inject({
    method: 'PUT',
    url: `/v2/promotions/${promotionId}/segments/${body.inventories.projectionInventorySegment.segmentId}`,
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-prosa-transport-hash': fx.projDigest,
      'x-prosa-device-id': deviceId,
    },
    payload: Buffer.from(fx.projBytes),
  })
  await t.app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/object-packs`,
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-prosa-transport-hash': transportHashOf(fx.pack.bytes),
      'x-prosa-device-id': deviceId,
    },
    payload: Buffer.from(fx.pack.bytes),
  })
  return { promotionId }
}

async function sealPromotion(
  t: TestApp,
  token: string,
  promotionId: string,
  deviceId: string,
): Promise<{ statusCode: number; body: { status?: string; receipt?: { payload: { receiptId: string } } } }> {
  const seal = await t.app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/seal`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-prosa-device-id': deviceId,
    },
    payload: {} as never,
  })
  return { statusCode: seal.statusCode, body: seal.json() as never }
}

function payloadDraftFor(opts: {
  tenantId: string
  storeId: string
  deviceId: string
  bundleRoot: string
  receiptId: string
}) {
  return {
    receiptVersion: 2 as const,
    receiptId: opts.receiptId,
    protocolVersion: 2 as const,
    tenantId: opts.tenantId,
    storeId: opts.storeId,
    storePath: '/home/test/store',
    deviceId: opts.deviceId,
    issuedAt: '2026-05-20T00:00:00.000Z',
    serverRegion: 'test',
    serverKeyId: 'test-kid',
    previousReceiptId: null,
    previousBundleRoot: null,
    bundleRoot: opts.bundleRoot,
    rawSourceRoot: '00'.repeat(32),
    counts: {
      sourceFiles: 0,
      rawRecords: 0,
      objects: 0,
      sessions: 0,
      messages: 0,
      events: 0,
      contentBlocks: 0,
      turns: 0,
      toolCalls: 0,
      toolResults: 0,
      artifacts: 0,
      edges: 0,
      searchDocs: 0,
      projectionRows: 0,
    },
    materialization: {
      postgresCommitId: 'pg-cq136',
      searchGenerationId: 'gen-cq136',
      rowCountsByEntity: {
        session: 0,
        message: 0,
        event: 0,
        content_block: 0,
        turn: 0,
        tool_call: 0,
        tool_result: 0,
        artifact: 0,
        edge: 0,
        project: 0,
        source_file: 0,
        raw_record: 0,
        search_doc: 0,
      },
    },
    verification: {
      uploadDigestVerified: true as const,
      objectHashesVerifiedAtIngest: true as const,
      projectionRowsLoaded: true as const,
      noPerObjectHeadRequired: true as const,
      backgroundAuditEligible: true as const,
    },
    clientSignatureStatus: 'absent_v2_0' as const,
  }
}

describe('CQ-136 (link validation): sealed-replay validates derived id and signature', () => {
  it('fails closed when sealed_receipt_id points at a payload whose derived id no longer matches', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq136v-tamper@example.com', 'Acme', 'acme-cq136v-tamper')
      const storeId = 'store-cq136v-tamper'
      const bundleRoot = '11'.repeat(32)
      const fx = buildFixture('cq136v-tamper')
      const { promotionId } = await drivePromotionThroughUploads(
        t,
        account.token,
        buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot, declaredObjectCount: 1, fx }),
        fx,
      )
      const sealResp = await sealPromotion(t, account.token, promotionId, `${storeId}-dev`)
      expect(sealResp.statusCode).toBe(200)

      // Build a spoof receipt: tuple matches the staging row,
      // but the stored payload has a non-tuple field flipped so
      // deriveReceiptId(payload) !== payload.receiptId.
      const deviceId = `${storeId}-dev`
      const draft = payloadDraftFor({
        tenantId: account.tenant.id,
        storeId,
        deviceId,
        bundleRoot,
        receiptId: 'rcpt_placeholder',
      })
      const spoofReceiptId = deriveReceiptId(draft)
      const goodPayload = { ...draft, receiptId: spoofReceiptId }
      const signature = await t.signer.signReceipt(receiptPayloadBytes(goodPayload))
      const tamperedPayload = { ...goodPayload, serverRegion: 'tampered' }

      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          spoofReceiptId,
          account.tenant.id,
          storeId,
          deviceId,
          JSON.stringify(tamperedPayload),
          JSON.stringify(signature),
        ],
      )
      await t.db.rawExec(`UPDATE promotion_staging SET sealed_receipt_id = $1 WHERE id = $2`, [
        spoofReceiptId,
        promotionId,
      ])

      const replay = await sealPromotion(t, account.token, promotionId, `${storeId}-dev`)
      expect(replay.statusCode).toBe(500)
      const body = replay.body as { code?: string; message?: string }
      expect(body.code).toBe('SEAL_LINK_CORRUPT')
      expect(body.message ?? '').toMatch(/hashes/i)
    } finally {
      await t.close()
    }
  })

  it('fails closed when sealed_receipt_id points at a payload whose signature does not verify', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq136v-sig@example.com', 'Acme', 'acme-cq136v-sig')
      const storeId = 'store-cq136v-sig'
      const bundleRoot = '22'.repeat(32)
      const fx = buildFixture('cq136v-sig')
      const { promotionId } = await drivePromotionThroughUploads(
        t,
        account.token,
        buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot, declaredObjectCount: 1, fx }),
        fx,
      )
      expect((await sealPromotion(t, account.token, promotionId, `${storeId}-dev`)).statusCode).toBe(200)

      const deviceId = `${storeId}-dev`
      const draft = payloadDraftFor({
        tenantId: account.tenant.id,
        storeId,
        deviceId,
        bundleRoot,
        receiptId: 'rcpt_placeholder',
      })
      const spoofReceiptId = deriveReceiptId(draft)
      const payload = { ...draft, receiptId: spoofReceiptId }
      // Bogus signature: right shape (Ed25519 + 64-byte
      // base64url), wrong bytes. verifyReceipt fails.
      const badSig = {
        alg: 'Ed25519' as const,
        keyId: t.signer.currentKeyId(),
        sig: Buffer.alloc(64).toString('base64url'),
      }

      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [spoofReceiptId, account.tenant.id, storeId, deviceId, JSON.stringify(payload), JSON.stringify(badSig)],
      )
      await t.db.rawExec(`UPDATE promotion_staging SET sealed_receipt_id = $1 WHERE id = $2`, [
        spoofReceiptId,
        promotionId,
      ])

      const replay = await sealPromotion(t, account.token, promotionId, `${storeId}-dev`)
      expect(replay.statusCode).toBe(500)
      const body = replay.body as { code?: string; message?: string }
      expect(body.code).toBe('SEAL_LINK_CORRUPT')
      expect(body.message ?? '').toMatch(/signature/i)
    } finally {
      await t.close()
    }
  })

  it('fails closed when sealed_receipt_id points at a payload signed by a foreign signer (keyId spoofed)', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq136v-foreign@example.com', 'Acme', 'acme-cq136v-foreign')
      const storeId = 'store-cq136v-foreign'
      const bundleRoot = '33'.repeat(32)
      const fx = buildFixture('cq136v-foreign')
      const { promotionId } = await drivePromotionThroughUploads(
        t,
        account.token,
        buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot, declaredObjectCount: 1, fx }),
        fx,
      )
      expect((await sealPromotion(t, account.token, promotionId, `${storeId}-dev`)).statusCode).toBe(200)

      const deviceId = `${storeId}-dev`
      const draft = payloadDraftFor({
        tenantId: account.tenant.id,
        storeId,
        deviceId,
        bundleRoot,
        receiptId: 'rcpt_placeholder',
      })
      const spoofReceiptId = deriveReceiptId(draft)
      const payload = { ...draft, receiptId: spoofReceiptId }
      const { createLocalReceiptSigner } = await import('../../../src/v2/signing/local-signer.js')
      const foreign = createLocalReceiptSigner({ kidPrefix: 'cq136-foreign' })
      const foreignSig = await foreign.signReceipt(receiptPayloadBytes(payload))
      const spoofed = { ...foreignSig, keyId: t.signer.currentKeyId() }

      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [spoofReceiptId, account.tenant.id, storeId, deviceId, JSON.stringify(payload), JSON.stringify(spoofed)],
      )
      await t.db.rawExec(`UPDATE promotion_staging SET sealed_receipt_id = $1 WHERE id = $2`, [
        spoofReceiptId,
        promotionId,
      ])

      const replay = await sealPromotion(t, account.token, promotionId, `${storeId}-dev`)
      expect(replay.statusCode).toBe(500)
      const body = replay.body as { code?: string }
      expect(body.code).toBe('SEAL_LINK_CORRUPT')
    } finally {
      await t.close()
    }
  })
})
