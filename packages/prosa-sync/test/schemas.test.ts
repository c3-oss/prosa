import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  commitUploadInputSchema,
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
    })
    expect(parsed.sessions[0]?.turnCount).toBe(5)
    expect(parsed.searchDocs).toHaveLength(1)
  })
})
