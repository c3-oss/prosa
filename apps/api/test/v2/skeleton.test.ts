import { describe, expect, it } from 'vitest'
import { V2_PROMOTION_ROUTES, V2_RECEIPT_KEYS_PATH } from '../../src/v2/index.js'
import { type TestApp, buildTestApp } from '../helpers/test-app.js'

function placeholderUrl(template: string): string {
  return template
    .replace(':promotionId', 'prm_test_123')
    .replace(':segmentId', 'seg_test_456')
    .replace(':receiptId', 'rcp_test_789')
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
      result: { data: { token: string; user: { id: string; email: string }; tenant: { id: string } } }
    }
  ).result.data
}

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
        const url = placeholderUrl(route.url)
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

  it('every Lane 5 promotion route is now implemented (no 501 left)', async () => {
    // After slice 6 all five routes are wired. This test pins the
    // assertion so a regression that re-introduces 501 on any route
    // fails immediately. Auth ladder + route-specific responses are
    // covered by the per-slice focused tests under `test/v2/sync/`.
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'v2-no501@example.com', 'Acme', 'acme-no501')
      for (const route of V2_PROMOTION_ROUTES) {
        const url = placeholderUrl(route.url)
        const response = await t.app.inject({
          method: route.method,
          url,
          headers: { authorization: `Bearer ${account.token}` },
        })
        expect(response.statusCode, `${route.method} ${url}`).not.toBe(501)
      }
    } finally {
      await t.close()
    }
  })

  it('exactly matches the Lane 5 method/path contract', () => {
    const actual = V2_PROMOTION_ROUTES.map((r) => `${r.method} ${r.url}`).sort()
    const expected = [
      'POST /v2/promotions/begin',
      'PUT /v2/promotions/:promotionId/segments/:segmentId',
      'POST /v2/promotions/:promotionId/object-packs',
      'POST /v2/promotions/:promotionId/seal',
      'GET /v2/receipts/:receiptId',
    ].sort()
    expect(actual).toEqual(expected)
  })

  it('registers each Lane 5 promotion route definition', () => {
    const ops = V2_PROMOTION_ROUTES.map((r) => r.opName).sort()
    expect(ops).toEqual(['BeginPromotion', 'GetReceipt', 'SealPromotion', 'UploadObjectPack', 'UploadSegment'].sort())
  })
})
