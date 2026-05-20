// CQ-125 (signature + derived-id validation): BeginPromotion's
// `already_promoted` fast path must NOT return a stored receipt
// whose payload bytes do not hash to the signed receipt id, or
// whose signature does not verify against the server JWKS. The
// reviewer rejected the earlier tuple-only closure because a
// same-tenant attacker who tampered with the JSONB row (e.g.
// flipping `serverRegion` after sealing) or injected a bogus
// signature could still get the route to return
// `200 already_promoted`. Both axes now fail closed with
// `AUTHORITY_CORRUPT`.

import { deriveReceiptId, receiptPayloadBytes } from '@c3-oss/prosa-types-v2'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

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

function buildBeginBody(opts: { tenantId: string; storeId: string; bundleRoot: string; deviceId?: string }) {
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
        objects: 0,
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
        segmentId: 'cq125v-obj',
        kind: 'inventory_object',
        digest: `blake3:${'aa'.repeat(32)}`,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: 32,
      },
      projectionInventorySegment: {
        segmentId: 'cq125v-proj',
        kind: 'inventory_projection',
        digest: `blake3:${'bb'.repeat(32)}`,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: 32,
      },
    },
    device: { deviceId: opts.deviceId ?? 'dev-cq125v' },
  }
}

function buildPayloadDraft(opts: { tenantId: string; storeId: string; bundleRoot: string; deviceId: string }) {
  return {
    receiptVersion: 2 as const,
    receiptId: 'rcpt_placeholder',
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
    materialization: {
      postgresCommitId: 'pg-commit-1',
      searchGenerationId: 'gen-1',
      rowCountsByEntity: {
        session: 1,
        message: 1,
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
        search_doc: 1,
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

describe('CQ-125 (validation): BeginPromotion fast path verifies derived-id and signature', () => {
  it('returns 500 AUTHORITY_CORRUPT when the stored payload bytes no longer hash to the signed receipt id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq125v-tamper@example.com', 'Acme', 'acme-cq125v-tamper')
      const storeId = 'store-cq125v-tamper'
      const bundleRoot = '11'.repeat(32)
      const deviceId = 'dev-cq125v-tamper'

      // Build a payload, derive the canonical id, sign with the
      // app's signer — then MUTATE a non-tuple field after the
      // fact. payload.receiptId remains the original derived id;
      // deriveReceiptId(mutatedPayload) will no longer match it.
      const draft = buildPayloadDraft({ tenantId: account.tenant.id, storeId, bundleRoot, deviceId })
      const receiptId = deriveReceiptId(draft)
      const goodPayload = { ...draft, receiptId }
      const signature = await t.signer.signReceipt(receiptPayloadBytes(goodPayload))
      const tamperedPayload = { ...goodPayload, serverRegion: 'tampered' }

      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [receiptId, account.tenant.id, storeId, deviceId, JSON.stringify(tamperedPayload), JSON.stringify(signature)],
      )
      await t.db.rawExec(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
         VALUES ($1, $2, $3, $4, now())`,
        [account.tenant.id, storeId, receiptId, bundleRoot],
      )

      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot, deviceId }) as never,
      })
      expect(response.statusCode).toBe(500)
      const body = response.json() as { code: string; message?: string }
      expect(body.code).toBe('AUTHORITY_CORRUPT')
      expect(body.message ?? '').toMatch(/deriveReceiptId/i)
    } finally {
      await t.close()
    }
  })

  it('returns 500 AUTHORITY_CORRUPT when the signature does not verify (bogus base64url sig of the right shape)', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq125v-sig@example.com', 'Acme', 'acme-cq125v-sig')
      const storeId = 'store-cq125v-sig'
      const bundleRoot = '22'.repeat(32)
      const deviceId = 'dev-cq125v-sig'

      const draft = buildPayloadDraft({ tenantId: account.tenant.id, storeId, bundleRoot, deviceId })
      const receiptId = deriveReceiptId(draft)
      const payload = { ...draft, receiptId }
      // Schema-valid signature (right shape, right keyId, right
      // base64url-encoded length) but bogus bytes — Ed25519
      // verification fails.
      const badSig = {
        alg: 'Ed25519' as const,
        keyId: t.signer.currentKeyId(),
        sig: Buffer.alloc(64).toString('base64url'),
      }

      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [receiptId, account.tenant.id, storeId, deviceId, JSON.stringify(payload), JSON.stringify(badSig)],
      )
      await t.db.rawExec(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
         VALUES ($1, $2, $3, $4, now())`,
        [account.tenant.id, storeId, receiptId, bundleRoot],
      )

      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot, deviceId }) as never,
      })
      expect(response.statusCode).toBe(500)
      const body = response.json() as { code: string; message?: string }
      expect(body.code).toBe('AUTHORITY_CORRUPT')
      expect(body.message ?? '').toMatch(/signature/i)
    } finally {
      await t.close()
    }
  })

  it('returns 500 AUTHORITY_CORRUPT when the signature was minted by a different signer (key id known to current signer)', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq125v-wrong@example.com', 'Acme', 'acme-cq125v-wrong')
      const storeId = 'store-cq125v-wrong'
      const bundleRoot = '33'.repeat(32)
      const deviceId = 'dev-cq125v-wrong'

      const draft = buildPayloadDraft({ tenantId: account.tenant.id, storeId, bundleRoot, deviceId })
      const receiptId = deriveReceiptId(draft)
      const payload = { ...draft, receiptId }

      // Re-sign with a SECOND signer (different Ed25519 key) but
      // forge `keyId` to the current signer's so the verifier
      // tries to verify with the wrong public key.
      const { createLocalReceiptSigner } = await import('../../../src/v2/signing/local-signer.js')
      const foreign = createLocalReceiptSigner({ kidPrefix: 'cq125v-foreign' })
      const foreignSig = await foreign.signReceipt(receiptPayloadBytes(payload))
      const spoofed = { ...foreignSig, keyId: t.signer.currentKeyId() }

      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [receiptId, account.tenant.id, storeId, deviceId, JSON.stringify(payload), JSON.stringify(spoofed)],
      )
      await t.db.rawExec(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
         VALUES ($1, $2, $3, $4, now())`,
        [account.tenant.id, storeId, receiptId, bundleRoot],
      )

      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot, deviceId }) as never,
      })
      expect(response.statusCode).toBe(500)
      const body = response.json() as { code: string }
      expect(body.code).toBe('AUTHORITY_CORRUPT')
    } finally {
      await t.close()
    }
  })

  it('returns 200 already_promoted when both derived-id and signature verify', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq125v-happy@example.com', 'Acme', 'acme-cq125v-happy')
      const storeId = 'store-cq125v-happy'
      const bundleRoot = '44'.repeat(32)
      const deviceId = 'dev-cq125v-happy'

      const draft = buildPayloadDraft({ tenantId: account.tenant.id, storeId, bundleRoot, deviceId })
      const receiptId = deriveReceiptId(draft)
      const payload = { ...draft, receiptId }
      const signature = await t.signer.signReceipt(receiptPayloadBytes(payload))

      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [receiptId, account.tenant.id, storeId, deviceId, JSON.stringify(payload), JSON.stringify(signature)],
      )
      await t.db.rawExec(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
         VALUES ($1, $2, $3, $4, now())`,
        [account.tenant.id, storeId, receiptId, bundleRoot],
      )

      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot, deviceId }) as never,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { status: string; receipt: { payload: { receiptId: string } } }
      expect(body.status).toBe('already_promoted')
      expect(body.receipt.payload.receiptId).toBe(receiptId)
    } finally {
      await t.close()
    }
  })
})
