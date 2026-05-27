// CQ-005: receiptPayloadBytes and deriveReceiptId are deterministic, every
// field change flips the receiptId, and nested objects are encoded with
// pinned field order.

import { describe, expect, it } from 'vitest'

import { deriveReceiptId, receiptPayloadBytes, toHex } from '../src/canonical.js'

const HEX64 = (c: string) => c.repeat(64)

function basePayload() {
  return {
    receiptVersion: 2,
    receiptId: '',
    protocolVersion: 2,
    tenantId: 'tnt_a',
    storeId: 'st_a',
    storePath: '/tmp/store',
    deviceId: 'dev_a',
    issuedAt: '2025-01-02T03:04:05.000Z',
    serverRegion: 'us-east-1',
    serverKeyId: 'key_1',
    previousReceiptId: null,
    previousBundleRoot: null,
    bundleRoot: HEX64('1'),
    rawSourceRoot: HEX64('2'),
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
      uploadDigestVerified: true,
      objectHashesVerifiedAtIngest: true,
      projectionRowsLoaded: true,
      noPerObjectHeadRequired: true,
      backgroundAuditEligible: true,
    },
    clientSignatureStatus: 'absent_v2_0',
  }
}

describe('receiptPayloadBytes / deriveReceiptId (CQ-005)', () => {
  it('encodes deterministically', () => {
    const a = toHex(receiptPayloadBytes(basePayload() as never))
    const b = toHex(receiptPayloadBytes(basePayload() as never))
    expect(a).toBe(b)
  })

  it('changes when bundleRoot changes', () => {
    const a = deriveReceiptId(basePayload() as never)
    const p = basePayload()
    p.bundleRoot = HEX64('9')
    const b = deriveReceiptId(p as never)
    expect(a).not.toBe(b)
  })

  it('changes when rawSourceRoot changes', () => {
    const a = deriveReceiptId(basePayload() as never)
    const p = basePayload()
    p.rawSourceRoot = HEX64('9')
    expect(deriveReceiptId(p as never)).not.toBe(a)
  })

  it('changes when any count changes', () => {
    const a = deriveReceiptId(basePayload() as never)
    const p = basePayload()
    p.counts.sessions = 2
    expect(deriveReceiptId(p as never)).not.toBe(a)
  })

  it('changes when any materialization field changes', () => {
    const a = deriveReceiptId(basePayload() as never)
    const p = basePayload()
    p.materialization.postgresCommitId = '0/99999'
    expect(deriveReceiptId(p as never)).not.toBe(a)
  })

  it('changes when any rowCountsByEntity value changes', () => {
    const a = deriveReceiptId(basePayload() as never)
    const p = basePayload()
    p.materialization.rowCountsByEntity.session = 99
    expect(deriveReceiptId(p as never)).not.toBe(a)
  })

  it('is independent of rowCountsByEntity object key insertion order', () => {
    // Reorder the rowCountsByEntity keys at construction; the canonical
    // encoder uses CANONICAL_ENTITY_TYPES order regardless.
    const p1 = basePayload()
    const reorderedKeys = Object.keys(p1.materialization.rowCountsByEntity).reverse()
    const reordered: Record<string, number> = {}
    for (const k of reorderedKeys) {
      reordered[k] = (p1.materialization.rowCountsByEntity as Record<string, number>)[k] as number
    }
    const p2 = basePayload()
    p2.materialization.rowCountsByEntity = reordered as typeof p2.materialization.rowCountsByEntity
    expect(deriveReceiptId(p2 as never)).toBe(deriveReceiptId(p1 as never))
  })

  it('produces a receiptId of the form rcpt_<base32-lower-no-pad>', () => {
    const id = deriveReceiptId(basePayload() as never)
    expect(id).toMatch(/^rcpt_[a-z2-7]+$/)
    // BLAKE3 is 32 bytes = 256 bits → 52 base32 chars (no padding).
    expect(id.slice(5).length).toBe(52)
  })

  it('zeroes the receiptId field when seeding the hash', () => {
    // Setting receiptId before calling deriveReceiptId must not change the
    // result.
    const a = deriveReceiptId(basePayload() as never)
    const p = basePayload()
    ;(p as { receiptId: string }).receiptId = 'rcpt_garbage'
    expect(deriveReceiptId(p as never)).toBe(a)
  })
})
