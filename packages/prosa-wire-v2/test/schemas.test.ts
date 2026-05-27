import { deriveReceiptId } from '@c3-oss/prosa-types-v2'
import { describe, expect, it } from 'vitest'

import {
  PROTOCOL_VERSION_V2,
  beginPromotionRequestSchema,
  beginPromotionResponseSchema,
  bundleHeadV2Schema,
  getReceiptRequestSchema,
  getReceiptResponseSchema,
  promotionReceiptV2Schema,
  sealPromotionResponseSchema,
  segmentRefSchema,
  uploadObjectPackHeaderSchema,
  uploadSegmentRequestSchema,
} from '../src/index.js'

const hash64 = (c = 'a') => c.repeat(64)
const taggedHash = (c = 'a') => `blake3:${hash64(c)}`

const inventorySegment = (id: string) => ({
  segmentId: id,
  kind: 'inventory_object' as const,
  digest: taggedHash('b'),
  logicalRoot: 'root_b',
  compression: 'zstd' as const,
  byteLength: 1024,
})

const bundleHead = {
  bundleFormat: 2 as const,
  storeId: 'store_1',
  storePath: '/tmp/store',
  epoch: 7,
  parserVersion: '2.0.0',
  createdAt: '2025-01-02T03:04:05.123Z',
  previousBundleRoot: null,
  bundleRoot: hash64('1'),
  rawSourceRoot: hash64('2'),
  manifestDigest: taggedHash('a'),
  counts: {
    sourceFiles: 1,
    rawRecords: 1,
    objects: 1,
    sessions: 1,
    turns: 0,
    events: 0,
    messages: 1,
    contentBlocks: 1,
    toolCalls: 0,
    toolResults: 0,
    artifacts: 0,
    edges: 0,
    searchDocs: 1,
    projectionRows: 6,
  },
  segments: [],
}

function makeReceipt() {
  // Build the payload with a placeholder receiptId, then ask the canonical
  // helper to compute the canonical one. CQ-011: the schema verifies
  // payload.receiptId === deriveReceiptId(payload).
  const payloadSeed = {
    receiptVersion: 2 as const,
    receiptId: '',
    protocolVersion: 2 as const,
    tenantId: 't_a',
    storeId: 'store_1',
    storePath: '/tmp/store',
    deviceId: 'dev_1',
    issuedAt: '2025-01-02T03:04:06.000Z',
    serverRegion: 'us-east-1',
    serverKeyId: 'key_1',
    previousReceiptId: null,
    previousBundleRoot: null,
    bundleRoot: hash64('1'),
    rawSourceRoot: hash64('2'),
    counts: bundleHead.counts,
    materialization: {
      postgresCommitId: '0/12345',
      searchGenerationId: 'gen_1',
      rowCountsByEntity: {
        artifact: 0,
        content_block: 1,
        edge: 0,
        event: 0,
        message: 1,
        project: 0,
        raw_record: 1,
        search_doc: 1,
        session: 1,
        source_file: 1,
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
  const receiptId = deriveReceiptId(payloadSeed)
  return {
    payload: { ...payloadSeed, receiptId },
    signature: {
      alg: 'Ed25519' as const,
      keyId: 'key_1',
      sig: 'sig-bytes-base64url',
    },
  }
}

const receipt = makeReceipt()

describe('wire schemas', () => {
  it('exports PROTOCOL_VERSION_V2 = 2', () => {
    expect(PROTOCOL_VERSION_V2).toBe(2)
  })

  it('round-trips a SegmentRef', () => {
    const parsed = segmentRefSchema.parse(inventorySegment('seg_1'))
    expect(parsed.segmentId).toBe('seg_1')
  })

  it('round-trips a BundleHeadV2', () => {
    const parsed = bundleHeadV2Schema.parse(bundleHead)
    expect(parsed.epoch).toBe(7)
  })

  it('rejects a BundleHeadV2 with a non-hex root', () => {
    const bad = { ...bundleHead, bundleRoot: 'not-hex' }
    const result = bundleHeadV2Schema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'bundleRoot')).toBe(true)
    }
  })

  it('round-trips a PromotionReceiptV2 with derived receiptId', () => {
    const parsed = promotionReceiptV2Schema.parse(receipt)
    expect(parsed.payload.receiptId).toMatch(/^rcpt_[a-z2-7]+$/)
  })

  it('rejects a receipt with an invalid receiptId prefix', () => {
    const bad = {
      ...receipt,
      payload: { ...receipt.payload, receiptId: 'rec_abc' },
    }
    expect(promotionReceiptV2Schema.safeParse(bad).success).toBe(false)
  })

  it('rejects a receipt whose payload was changed without recomputing receiptId (CQ-011)', () => {
    const bad = {
      ...receipt,
      payload: { ...receipt.payload, tenantId: 't_other' },
    }
    const result = promotionReceiptV2Schema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join('.') === 'payload.receiptId' && /does not match/.test(i.message)),
      ).toBe(true)
    }
  })

  it('parses BeginPromotionRequest', () => {
    const req = beginPromotionRequestSchema.parse({
      protocolVersion: 2,
      tenantId: 't_a',
      storeId: 'store_1',
      storePath: '/tmp/store',
      head: bundleHead,
      inventories: {
        objectInventorySegment: inventorySegment('seg_obj'),
        projectionInventorySegment: inventorySegment('seg_proj'),
      },
      device: { deviceId: 'dev_1' },
    })
    expect(req.tenantId).toBe('t_a')
  })

  it('parses BeginPromotionResponse discriminated union (all 3 statuses)', () => {
    const already = beginPromotionResponseSchema.parse({
      status: 'already_promoted',
      receipt,
    })
    expect(already.status).toBe('already_promoted')

    const inv = beginPromotionResponseSchema.parse({
      status: 'needs_inventory',
      promotionId: 'pro_1',
      missingInventories: [inventorySegment('seg_obj')],
    })
    expect(inv.status).toBe('needs_inventory')

    const up = beginPromotionResponseSchema.parse({
      status: 'needs_upload',
      promotionId: 'pro_1',
      missingSegments: [inventorySegment('seg_obj')],
      missingObjects: {
        objectSetRoot: hash64('3'),
        inventoryDigest: taggedHash('4'),
        ordering: 'hash_alg_hash_hex_size_compression_ascending',
        encoding: 'none',
        objectCount: 0,
      },
    })
    expect(up.status).toBe('needs_upload')
  })

  it('rejects BeginPromotionResponse with an unknown status', () => {
    expect(beginPromotionResponseSchema.safeParse({ status: 'wat' }).success).toBe(false)
  })

  it('parses UploadSegmentRequest and UploadObjectPackHeader with transportHash (CQ-012)', () => {
    expect(
      uploadSegmentRequestSchema.parse({
        protocolVersion: 2,
        promotionId: 'pro_1',
        segment: inventorySegment('seg_a'),
        transportHash: taggedHash('e'),
      }).promotionId,
    ).toBe('pro_1')

    expect(
      uploadObjectPackHeaderSchema.parse({
        protocolVersion: 2,
        promotionId: 'pro_1',
        packDigest: taggedHash('c'),
        transportHash: taggedHash('f'),
        byteLength: 4096,
        objectCount: 2,
        objectSetRoot: hash64('d'),
        standaloneLargeObject: false,
      }).objectCount,
    ).toBe(2)
  })

  it('rejects UploadObjectPackHeader missing transportHash (CQ-012)', () => {
    const result = uploadObjectPackHeaderSchema.safeParse({
      protocolVersion: 2,
      promotionId: 'pro_1',
      packDigest: taggedHash('c'),
      byteLength: 4096,
      objectCount: 2,
      objectSetRoot: hash64('d'),
      standaloneLargeObject: false,
    })
    expect(result.success).toBe(false)
  })

  it('rejects UploadSegmentRequest with malformed transportHash', () => {
    const result = uploadSegmentRequestSchema.safeParse({
      protocolVersion: 2,
      promotionId: 'pro_1',
      segment: inventorySegment('seg_a'),
      transportHash: 'not-a-hash',
    })
    expect(result.success).toBe(false)
  })

  it('rejects bundleHead with manifestDigest in bare-hex form (CQ-004)', () => {
    const bad = { ...bundleHead, manifestDigest: hash64('m') }
    const result = bundleHeadV2Schema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('rejects bundleHead with bundleRoot in tagged-hash form (CQ-004)', () => {
    const bad = { ...bundleHead, bundleRoot: taggedHash('1') }
    const result = bundleHeadV2Schema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('parses SealPromotionResponse discriminated union', () => {
    expect(sealPromotionResponseSchema.parse({ status: 'materializing', promotionId: 'pro_1' }).status).toBe(
      'materializing',
    )
    expect(sealPromotionResponseSchema.parse({ status: 'sealed', receipt }).status).toBe('sealed')
    expect(sealPromotionResponseSchema.parse({ status: 'failed', promotionId: 'pro_1', reason: 'x' }).status).toBe(
      'failed',
    )
  })

  it('GetReceiptRequest uses canonical receipt id (CQ-011)', () => {
    expect(getReceiptRequestSchema.parse({ protocolVersion: 2, receiptId: receipt.payload.receiptId }).receiptId).toBe(
      receipt.payload.receiptId,
    )
    expect(getReceiptRequestSchema.safeParse({ protocolVersion: 2, receiptId: 'rcpt_BAD!' }).success).toBe(false)
  })

  it('rejects bundleHead with an impossible date in createdAt (CQ-016)', () => {
    const bad = { ...bundleHead, createdAt: '2025-02-30T00:00:00.000Z' }
    expect(bundleHeadV2Schema.safeParse(bad).success).toBe(false)
  })

  it('rejects bundleHead with month 99 in createdAt (CQ-016)', () => {
    const bad = { ...bundleHead, createdAt: '2025-99-01T00:00:00.000Z' }
    expect(bundleHeadV2Schema.safeParse(bad).success).toBe(false)
  })

  it('rejects segmentRef with an impossible date in minTimestamp (CQ-016)', () => {
    const bad = { ...inventorySegment('seg_a'), minTimestamp: '2025-02-30T00:00:00.000Z' }
    expect(segmentRefSchema.safeParse(bad).success).toBe(false)
  })

  it('parses GetReceiptResponse discriminated union (CQ-011)', () => {
    expect(getReceiptResponseSchema.parse({ status: 'found', receipt }).status).toBe('found')
    expect(getReceiptResponseSchema.parse({ status: 'not_found', receiptId: receipt.payload.receiptId }).status).toBe(
      'not_found',
    )
    // not_found id must satisfy canonical receiptIdSchema.
    expect(getReceiptResponseSchema.safeParse({ status: 'not_found', receiptId: 'rcpt_UPPER' }).success).toBe(false)
  })
})
