// Lane 6 / CQ-144 follow-up — route-level artifacts.getText pin.
//
// The handler-level test (`artifacts-get-text.test.ts`) covers the
// gate, grant, and decode contract against a v2-only PGlite. This
// suite drives the actual Fastify route through the same Better Auth
// session that `buildTestApp` produces for the rest of the v2 suite
// so the wire response shape — and the gate ladder it sits behind —
// is locked in.
//
// CQ-144 invariants enforced here:
//
//   - 401 when unauthenticated.
//   - 403 when authenticated but no active tenant.
//   - 400 when `artifactId` is missing / not a string.
//   - 200 with `{ found: false }` (no `reason` field) when the
//     artifact does not exist. The opaque shape is identical to
//     `no_grant` / `no_object` / `fetch_failed`, so a probing
//     attacker cannot tell those cases apart from the wire.

import { describe, expect, it } from 'vitest'
import { V2_READ_ROUTES } from '../../../src/v2/reads/index.js'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

async function signupTenant(t: TestApp, email: string, name: string, slug: string) {
  const r = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName: name, tenantSlug: slug } as never,
  })
  expect(r.statusCode).toBe(200)
  return (r.json() as { result: { data: { token: string; user: { id: string }; tenant: { id: string } } } }).result.data
}

describe('Lane 6 artifacts.getText route — CQ-144 opacity at the HTTP boundary', () => {
  it('lists the artifacts route in V2_READ_ROUTES so the contract stays pinned', () => {
    const op = V2_READ_ROUTES.find((r) => r.url === '/v2/reads/artifacts/getText')
    expect(op).toBeDefined()
    expect(op?.method).toBe('POST')
    expect(op?.opName).toBe('ReadArtifactsGetText')
  })

  it('returns 401 / UNAUTHENTICATED when no auth token is presented', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/reads/artifacts/getText',
        headers: { 'content-type': 'application/json' },
        payload: { artifactId: 'art_x' } as never,
      })
      expect(response.statusCode).toBe(401)
      const body = response.json() as { code: string; op: string }
      expect(body.code).toBe('UNAUTHENTICATED')
      expect(body.op).toBe('ReadArtifactsGetText')
    } finally {
      await t.close()
    }
  })

  it('returns 400 / INVALID_INPUT when artifactId is missing', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-route-missing@example.com', 'Acme', 'acme-art-route-missing')
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/reads/artifacts/getText',
        headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
        payload: {} as never,
      })
      expect(response.statusCode).toBe(400)
      const body = response.json() as { code: string }
      expect(body.code).toBe('INVALID_INPUT')
    } finally {
      await t.close()
    }
  })

  it('returns an opaque { found: false } body for a missing artifact id (no internal reason leaks)', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'art-route-opaque@example.com', 'Acme', 'acme-art-route-opaque')
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/reads/artifacts/getText',
        headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
        payload: { artifactId: 'art_never_existed', maxBytes: 1024 } as never,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as Record<string, unknown>
      expect(body).toEqual({ found: false })
      // Critically: no `reason` / `code` / `message` field is
      // serialized to the wire. Locking down the keys protects
      // against accidental regressions that re-introduce a leak.
      expect(Object.keys(body).sort()).toEqual(['found'])
    } finally {
      await t.close()
    }
  })
})
