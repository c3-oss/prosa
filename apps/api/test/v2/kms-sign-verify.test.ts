// Invariant I5: a server-signed v2 receipt verifies against the
// published JWKS through the canonical receipt payload bytes — not
// arbitrary strings.
//
// The signer must emit `alg: 'Ed25519'` (the v2 wire algorithm name),
// while the JWKS keys use the JWA name `alg: 'EdDSA'` (RFC 8037 §3.1).
// CQ-121 opened because these two fields were conflated; the test now
// pins the distinction.

import type { PromotionReceiptV2, PromotionReceiptV2Payload } from '@c3-oss/prosa-types-v2'
import { deriveReceiptId, receiptPayloadBytes } from '@c3-oss/prosa-types-v2'
import { promotionReceiptV2Schema } from '@c3-oss/prosa-wire-v2'
import { describe, expect, it } from 'vitest'
import { createLocalReceiptSigner } from '../../src/v2/signing/local-signer.js'

const ZERO_HEX = '0'.repeat(64)

function makePayloadDraft(overrides: Partial<PromotionReceiptV2Payload> = {}): PromotionReceiptV2Payload {
  const base: PromotionReceiptV2Payload = {
    receiptVersion: 2,
    receiptId: '',
    protocolVersion: 2,
    tenantId: 't_acme',
    storeId: 'st_main',
    storePath: '/var/lib/prosa/acme/main',
    deviceId: 'dev_alpha',
    issuedAt: '2026-05-20T03:30:00.000Z',
    serverRegion: 'us-east-1',
    serverKeyId: 'placeholder',
    previousReceiptId: null,
    previousBundleRoot: null,
    bundleRoot: ZERO_HEX,
    rawSourceRoot: ZERO_HEX,
    counts: {
      sourceFiles: 0,
      rawRecords: 0,
      objects: 0,
      sessions: 0,
      turns: 0,
      events: 0,
      messages: 0,
      contentBlocks: 0,
      toolCalls: 0,
      toolResults: 0,
      artifacts: 0,
      edges: 0,
      searchDocs: 0,
      projectionRows: 0,
    },
    materialization: {
      postgresCommitId: 'commit-1',
      searchGenerationId: 'gen-1',
      rowCountsByEntity: {
        session: 0,
        message: 0,
        turn: 0,
        event: 0,
        content_block: 0,
        tool_call: 0,
        tool_result: 0,
        artifact: 0,
        edge: 0,
        raw_record: 0,
        source_file: 0,
        search_doc: 0,
        project: 0,
      },
    },
    verification: {
      uploadDigestVerified: true,
      objectHashesVerifiedAtIngest: true,
      projectionRowsLoaded: true,
      noPerObjectHeadRequired: true,
      backgroundAuditEligible: true,
    },
    clientSignatureStatus: 'absent_v2_0',
    ...overrides,
  }
  return base
}

function buildCanonicalPayload(
  serverKeyId: string,
  overrides: Partial<PromotionReceiptV2Payload> = {},
): {
  payload: PromotionReceiptV2Payload
  bytes: Uint8Array
} {
  const draft = makePayloadDraft({ serverKeyId, ...overrides })
  const receiptId = deriveReceiptId(draft)
  const payload: PromotionReceiptV2Payload = { ...draft, receiptId }
  const bytes = receiptPayloadBytes(payload)
  return { payload, bytes }
}

describe('local receipt signer (invariant I5)', () => {
  it('signs the canonical receipt bytes and produces a schema-valid v2 receipt', async () => {
    const signer = createLocalReceiptSigner()
    const { payload, bytes } = buildCanonicalPayload(signer.currentKeyId())

    const signature = await signer.signReceipt(bytes)
    expect(signature.alg).toBe('Ed25519')
    expect(signature.keyId).toBe(signer.currentKeyId())
    expect(signature.sig.length).toBeGreaterThan(0)

    // JWKS carries `alg: 'EdDSA'` (JWA name) for the same key.
    const jwks = signer.publishJwks()
    const currentJwk = jwks.keys.find((k) => k.kid === signature.keyId)
    expect(currentJwk).toBeDefined()
    expect(currentJwk?.alg).toBe('EdDSA')
    expect(currentJwk?.crv).toBe('Ed25519')

    // Roundtrip verification.
    const ok = await signer.verifyReceipt(bytes, signature)
    expect(ok).toBe(true)

    // The assembled receipt validates against the wire schema (which
    // also enforces `receiptId === deriveReceiptId(payload)`).
    const receipt: PromotionReceiptV2 = { payload, signature }
    const parsed = promotionReceiptV2Schema.safeParse(receipt)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).toBe(true)
  })

  it('rejects a tampered payload', async () => {
    const signer = createLocalReceiptSigner()
    const { payload, bytes } = buildCanonicalPayload(signer.currentKeyId())
    const signature = await signer.signReceipt(bytes)

    // Mutate the payload and re-encode — the new bytes must not verify.
    const mutated: PromotionReceiptV2Payload = {
      ...payload,
      storePath: `${payload.storePath}/tampered`,
    }
    const mutatedBytes = receiptPayloadBytes({ ...mutated, receiptId: '' })
    const ok = await signer.verifyReceipt(mutatedBytes, signature)
    expect(ok).toBe(false)
  })

  it('rejects a signature signed by an unrelated signer', async () => {
    const signerA = createLocalReceiptSigner()
    const signerB = createLocalReceiptSigner()
    const { bytes } = buildCanonicalPayload(signerB.currentKeyId())
    const signatureFromB = await signerB.signReceipt(bytes)
    const ok = await signerA.verifyReceipt(bytes, signatureFromB)
    expect(ok).toBe(false)
  })

  it('keeps historical keys queryable after rotation', async () => {
    const signer = createLocalReceiptSigner()
    const oldKid = signer.currentKeyId()
    const { bytes: oldBytes } = buildCanonicalPayload(oldKid, { storePath: '/before-rotation' })
    const signedBefore = await signer.signReceipt(oldBytes)

    const newKid = signer.rotateCurrentKey()
    expect(newKid).not.toBe(oldKid)

    const jwks = signer.publishJwks()
    expect(jwks.keys.map((k) => k.kid)).toEqual(expect.arrayContaining([oldKid, newKid]))

    // Old signature still verifies (historical key in JWKS).
    expect(await signer.verifyReceipt(oldBytes, signedBefore)).toBe(true)

    // New signature uses the rotated key id.
    const { bytes: newBytes } = buildCanonicalPayload(newKid, { storePath: '/after-rotation' })
    const signedAfter = await signer.signReceipt(newBytes)
    expect(signedAfter.keyId).toBe(newKid)
    expect(await signer.verifyReceipt(newBytes, signedAfter)).toBe(true)
  })

  it('rejects signatures with an unknown key id', async () => {
    const signer = createLocalReceiptSigner()
    const { bytes } = buildCanonicalPayload(signer.currentKeyId())
    const sig = await signer.signReceipt(bytes)
    const ok = await signer.verifyReceipt(bytes, { ...sig, keyId: 'kid-that-was-never-issued' })
    expect(ok).toBe(false)
  })

  it('rejects signatures with a non-Ed25519 alg', async () => {
    const signer = createLocalReceiptSigner()
    const { bytes } = buildCanonicalPayload(signer.currentKeyId())
    const sig = await signer.signReceipt(bytes)
    const ok = await signer.verifyReceipt(bytes, { ...sig, alg: 'EdDSA' as 'Ed25519' })
    expect(ok).toBe(false)
  })

  it('rejects an assembled receipt whose receiptId does not match deriveReceiptId', async () => {
    const signer = createLocalReceiptSigner()
    const { payload, bytes } = buildCanonicalPayload(signer.currentKeyId())
    const signature = await signer.signReceipt(bytes)
    const broken: PromotionReceiptV2 = {
      payload: { ...payload, receiptId: 'rcpt_tampered' },
      signature,
    }
    const parsed = promotionReceiptV2Schema.safeParse(broken)
    expect(parsed.success).toBe(false)
  })

  it('produces a wire-compatible signature.alg field (Ed25519, not EdDSA)', async () => {
    // CQ-121 regression: the receipt signature must use the v2 wire
    // algorithm name. EdDSA is the JWA name used inside the JWK, not
    // in `PromotionReceiptV2Signature`.
    const signer = createLocalReceiptSigner()
    const { bytes } = buildCanonicalPayload(signer.currentKeyId())
    const signature = await signer.signReceipt(bytes)
    expect(signature.alg).toBe('Ed25519')
    expect(signature.alg).not.toBe('EdDSA' as string)
  })
})
