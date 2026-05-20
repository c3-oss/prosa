import { describe, expect, it } from 'vitest'
import { V2_PROMOTION_ROUTES, V2_RECEIPT_KEYS_PATH } from '../../src/v2/index.js'
import { buildTestApp } from '../helpers/test-app.js'

describe('v2 plugin skeleton', () => {
  it('serves a JWKS document with at least one current EdDSA key', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({ method: 'GET', url: V2_RECEIPT_KEYS_PATH })
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toMatch(/application\/jwk-set\+json/)
      const body = response.json() as {
        keys: Array<{ kty: string; crv: string; alg: string; use: string; kid: string; x: string }>
      }
      expect(Array.isArray(body.keys)).toBe(true)
      expect(body.keys.length).toBeGreaterThanOrEqual(1)
      const current = body.keys[0]
      expect(current).toBeDefined()
      expect(current?.kty).toBe('OKP')
      expect(current?.crv).toBe('Ed25519')
      expect(current?.alg).toBe('EdDSA')
      expect(current?.use).toBe('sig')
      expect(typeof current?.kid).toBe('string')
      expect((current?.kid ?? '').length).toBeGreaterThan(0)
      expect(typeof current?.x).toBe('string')
      expect((current?.x ?? '').length).toBeGreaterThan(0)
    } finally {
      await t.close()
    }
  })

  it('returns 401 on every v2 promotion route when the caller is unauthenticated', async () => {
    const t = await buildTestApp()
    try {
      for (const route of V2_PROMOTION_ROUTES) {
        const url = route.url.replace(':promotionId', 'prm_test').replace(':receiptId', 'rcp_test')
        const response = await t.app.inject({ method: route.method, url })
        expect(response.statusCode, `${route.method} ${url}`).toBe(401)
        const body = response.json() as { code: string; op: string }
        expect(body.code).toBe('UNAUTHENTICATED')
        expect(body.op).toBe(route.opName)
      }
    } finally {
      await t.close()
    }
  })

  it('registers each Lane 5 promotion route definition', () => {
    const ops = V2_PROMOTION_ROUTES.map((r) => r.opName).sort()
    expect(ops).toEqual(['BeginPromotion', 'GetReceipt', 'SealPromotion', 'UploadObjectPack', 'UploadSegment'].sort())
  })
})
