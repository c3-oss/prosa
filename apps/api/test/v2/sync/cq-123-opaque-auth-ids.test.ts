// CQ-123: tenant / store / device fields in the v2 wire schema
// use `opaqueAuthIdSchema`, not `canonicalIdSchema`. Better
// Auth's mixed-case nanoids (e.g.
// `z3EIp38VKKSqPFuAk238kNUxGVWWf4RP`) now parse cleanly.
// Content-addressed ids — segments, packs, hashes,
// promotionId — keep the strict lowercase canonical schema
// (CQ-002).

import {
  beginPromotionResponseSchema,
  bundleHeadV2Schema,
  canonicalIdSchema,
  opaqueAuthIdSchema,
  promotionReceiptV2Schema,
} from '@c3-oss/prosa-wire-v2'
import { describe, expect, it } from 'vitest'

describe('CQ-123: opaqueAuthIdSchema accepts Better Auth ids; canonicalIdSchema still rejects them', () => {
  it('accepts mixed-case nanoids on tenant/store/device fields', () => {
    expect(opaqueAuthIdSchema.safeParse('z3EIp38VKKSqPFuAk238kNUxGVWWf4RP').success).toBe(true)
    expect(opaqueAuthIdSchema.safeParse('org_testLane5').success).toBe(true)
    expect(opaqueAuthIdSchema.safeParse('store-default').success).toBe(true)
    expect(opaqueAuthIdSchema.safeParse('dev-1').success).toBe(true)
  })

  it('still rejects empty / whitespace / overlong values', () => {
    expect(opaqueAuthIdSchema.safeParse('').success).toBe(false)
    expect(opaqueAuthIdSchema.safeParse(' has space').success).toBe(false)
    expect(opaqueAuthIdSchema.safeParse('a'.repeat(256)).success).toBe(false)
  })

  it('canonicalIdSchema keeps the lowercase contract for content-addressed ids', () => {
    expect(canonicalIdSchema.safeParse('seg-objects-1').success).toBe(true)
    expect(canonicalIdSchema.safeParse('z3EIp38V').success).toBe(false)
  })

  it('bundleHeadV2Schema accepts a mixed-case Better Auth storeId', () => {
    const result = bundleHeadV2Schema.safeParse({
      bundleFormat: 2,
      storeId: 'z3EIp38VKKSqPFuAk238kNUxGVWWf4RP',
      storePath: '/home/test/store',
      epoch: 0,
      parserVersion: '0.1.0',
      createdAt: '2026-05-20T00:00:00.000Z',
      previousBundleRoot: null,
      bundleRoot: '11'.repeat(32),
      rawSourceRoot: '22'.repeat(32),
      manifestDigest: `blake3:${'33'.repeat(32)}`,
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
      segments: [],
    })
    expect(result.success).toBe(true)
  })

  it('promotionReceiptV2Schema accepts mixed-case auth ids on the canonical receipt payload', async () => {
    const { deriveReceiptId } = await import('@c3-oss/prosa-types-v2')
    const draft = {
      receiptVersion: 2 as const,
      receiptId: 'rcpt_placeholder',
      protocolVersion: 2 as const,
      tenantId: 'z3EIp38VKKSqPFuAk238kNUxGVWWf4RP', // mixed case
      storeId: 'StoreMixedCase42',
      storePath: '/home/test/store',
      deviceId: 'Dev_BetterAuth',
      issuedAt: '2026-05-20T00:00:00.000Z',
      serverRegion: 'test',
      serverKeyId: 'k1',
      previousReceiptId: null,
      previousBundleRoot: null,
      bundleRoot: '11'.repeat(32),
      rawSourceRoot: '22'.repeat(32),
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
        postgresCommitId: 'pgc',
        searchGenerationId: 'gen',
        rowCountsByEntity: {
          artifact: 0,
          content_block: 0,
          edge: 0,
          event: 0,
          message: 0,
          project: 0,
          raw_record: 0,
          search_doc: 0,
          session: 0,
          source_file: 0,
          tool_call: 0,
          tool_result: 0,
          turn: 0,
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
    const id = deriveReceiptId(draft)
    const receipt = {
      payload: { ...draft, receiptId: id },
      signature: { alg: 'Ed25519' as const, keyId: 'k1', sig: Buffer.alloc(64).toString('base64url') },
    }
    const result = promotionReceiptV2Schema.safeParse(receipt)
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result.error.issues, null, 2))
    }
    expect(result.success).toBe(true)
  })

  it('beginPromotionResponseSchema parses an already_promoted receipt signed for mixed-case ids', async () => {
    // This is the regression CQ-123 originally flagged: the
    // client-side `beginPromotionResponseSchema.safeParse(body)`
    // call from the CLI would reject a receipt whose
    // tenantId/storeId/deviceId came from Better Auth. With
    // opaqueAuthIdSchema in place, that call now succeeds.
    const { deriveReceiptId } = await import('@c3-oss/prosa-types-v2')
    const draft = {
      receiptVersion: 2 as const,
      receiptId: 'rcpt_placeholder',
      protocolVersion: 2 as const,
      tenantId: 'z3EIp38VKKSqPFuAk238kNUxGVWWf4RP',
      storeId: 'StoreMixedCase42',
      storePath: '/home/test/store',
      deviceId: 'Dev_BetterAuth',
      issuedAt: '2026-05-20T00:00:00.000Z',
      serverRegion: 'test',
      serverKeyId: 'k1',
      previousReceiptId: null,
      previousBundleRoot: null,
      bundleRoot: '11'.repeat(32),
      rawSourceRoot: '22'.repeat(32),
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
        postgresCommitId: 'pgc',
        searchGenerationId: 'gen',
        rowCountsByEntity: {
          artifact: 0,
          content_block: 0,
          edge: 0,
          event: 0,
          message: 0,
          project: 0,
          raw_record: 0,
          search_doc: 0,
          session: 0,
          source_file: 0,
          tool_call: 0,
          tool_result: 0,
          turn: 0,
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
    const id = deriveReceiptId(draft)
    const result = beginPromotionResponseSchema.safeParse({
      status: 'already_promoted',
      receipt: {
        payload: { ...draft, receiptId: id },
        signature: { alg: 'Ed25519', keyId: 'k1', sig: Buffer.alloc(64).toString('base64url') },
      },
    })
    expect(result.success).toBe(true)
  })
})
