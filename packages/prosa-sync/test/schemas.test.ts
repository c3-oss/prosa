import { describe, expect, it } from 'vitest'
import {
  BinaryObjectPackFormatError,
  OBJECT_PACK_BINARY_CONTENT_TYPE,
  PROTOCOL_VERSION,
  commitUploadInputSchema,
  decodeBinaryObjectPack,
  encodeBinaryObjectPack,
  handshakeInputSchema,
  planUploadInputSchema,
  projectionPayloadSchema,
  verifyPromotionInputSchema,
} from '../src/index.js'

describe('sync schemas', () => {
  it('parses a minimal handshake', () => {
    const parsed = handshakeInputSchema.parse({
      cliVersion: '0.0.0',
      device: { name: 'laptop' },
      store: { path: '/tmp/.prosa', bundleVersion: '1' },
    })
    expect(parsed.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('defaults empty projection arrays in commit input', () => {
    const parsed = commitUploadInputSchema.parse({
      batchId: 'b1',
      deviceId: 'd1',
      storePath: '/tmp/.prosa',
    })
    expect(parsed.objects).toEqual([])
    expect(parsed.projection.sessions).toEqual([])
    expect(parsed.projection.toolCalls).toEqual([])
    expect(parsed.projection.toolResults).toEqual([])
  })

  it('rejects plan input without deviceId', () => {
    expect(() => planUploadInputSchema.parse({ storePath: '/x', objects: [] })).toThrow()
  })

  it('caps verify sample to 20 ids', () => {
    const ids = Array.from({ length: 21 }, (_, i) => `s${i}`)
    expect(() => verifyPromotionInputSchema.parse({ batchId: 'b1', storePath: '/x', sampleSessionIds: ids })).toThrow()
  })

  it('accepts a populated projection payload', () => {
    const parsed = projectionPayloadSchema.parse({
      sessions: [
        {
          id: 's1',
          sourceKind: 'codex',
          turnCount: 5,
        },
      ],
      searchDocs: [{ id: 'd1', sessionId: 's1', kind: 'session', body: 'hi' }],
      toolCalls: [{ id: 'tc1', sessionId: 's1', name: 'shell.exec', status: 'ok' }],
      toolResults: [{ id: 'tr1', toolCallId: 'tc1', status: 'ok' }],
    })
    expect(parsed.sessions[0]?.turnCount).toBe(5)
    expect(parsed.searchDocs).toHaveLength(1)
    expect(parsed.toolCalls).toHaveLength(1)
    expect(parsed.toolResults).toHaveLength(1)
  })
})

describe('binary object pack format', () => {
  const hash = 'a'.repeat(64)
  const entry = {
    objectId: `blake3:${hash}`,
    hash,
    hashAlgorithm: 'blake3' as const,
    compression: 'none' as const,
    compressedSize: 3,
    uncompressedSize: 3,
    transportHash: hash,
    contentType: 'text/plain',
    offset: 0,
    length: 3,
  }

  it('round-trips metadata and raw payload bytes', () => {
    const payload = new Uint8Array([1, 2, 3])
    const encoded = encodeBinaryObjectPack({ entries: [entry], payload })
    const decoded = decodeBinaryObjectPack(encoded)

    expect(OBJECT_PACK_BINARY_CONTENT_TYPE).toBe('application/vnd.prosa.object-pack.v1+binary')
    expect(decoded.entries).toEqual([entry])
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3])
  })

  it('rejects malformed binary packs', () => {
    expect(() => decodeBinaryObjectPack(new Uint8Array([1, 2, 3]))).toThrow(BinaryObjectPackFormatError)
  })

  it('enforces the optional binary header limit', () => {
    const encoded = encodeBinaryObjectPack({ entries: [entry], payload: new Uint8Array() })
    expect(() => decodeBinaryObjectPack(encoded, { maxHeaderBytes: 1 })).toThrow(/header exceeds limit/)
  })
})
