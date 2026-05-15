import { describe, expect, it } from 'vitest'
import { buildTestApp } from './helpers/test-app.js'

async function trpcMutation(
  app: Awaited<ReturnType<typeof buildTestApp>>['app'],
  path: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: input as unknown as string,
  })
}

describe('web auth surface', () => {
  it('auth.me returns the user, active tenant, role, and tenant list for a signed-up user', async () => {
    const t = await buildTestApp()
    try {
      const signup = await trpcMutation(t.app, 'auth.signupWithTenant', {
        email: 'me@example.com',
        password: 'correct-horse-battery',
        name: 'Mia',
        tenantName: 'Mia Inc',
        tenantSlug: 'mia-inc',
      })
      expect(signup.statusCode).toBe(200)
      const signupBody = signup.json() as {
        result: { data: { token: string; tenant: { id: string; slug: string | null } } }
      }
      const token = signupBody.result.data.token
      const tenantId = signupBody.result.data.tenant.id

      const meResponse = await t.app.inject({
        method: 'GET',
        url: '/trpc/auth.me',
        headers: {
          authorization: `Bearer ${token}`,
          'x-prosa-tenant-id': tenantId,
        },
      })
      expect(meResponse.statusCode).toBe(200)
      const body = meResponse.json() as {
        result: {
          data: {
            user: { id: string; email: string }
            tenantId: string | null
            memberRole: string | null
            tenants: Array<{ id: string; name: string; role: string; slug: string | null }>
          }
        }
      }
      expect(body.result.data.user.email).toBe('me@example.com')
      expect(body.result.data.tenantId).toBe(tenantId)
      expect(body.result.data.memberRole).toBe('admin')
      expect(body.result.data.tenants).toHaveLength(1)
      expect(body.result.data.tenants[0]?.id).toBe(tenantId)
      expect(body.result.data.tenants[0]?.role).toBe('admin')
      expect(body.result.data.tenants[0]?.slug).toBe('mia-inc')
    } finally {
      await t.close()
    }
  })

  it('CORS allows the configured browser origin with credentials but blocks unknown origins', async () => {
    const t = await buildTestApp({
      PROSA_WEB_ORIGIN: 'https://console.prosa.dev',
    })
    try {
      const allowed = await t.app.inject({
        method: 'OPTIONS',
        url: '/trpc/health.ping',
        headers: {
          origin: 'https://console.prosa.dev',
          'access-control-request-method': 'GET',
        },
      })
      expect(allowed.statusCode).toBeLessThan(400)
      expect(allowed.headers['access-control-allow-origin']).toBe('https://console.prosa.dev')
      expect(allowed.headers['access-control-allow-credentials']).toBe('true')

      const blocked = await t.app.inject({
        method: 'OPTIONS',
        url: '/trpc/health.ping',
        headers: {
          origin: 'https://attacker.example',
          'access-control-request-method': 'GET',
        },
      })
      // Either the preflight is rejected outright or the allow-origin header is
      // missing/different. Both are acceptable; reflecting `attacker.example`
      // is not.
      expect(blocked.headers['access-control-allow-origin']).not.toBe('https://attacker.example')
    } finally {
      await t.close()
    }
  })
})
