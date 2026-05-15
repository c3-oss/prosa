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

describe('auth.signupWithTenant', () => {
  it('creates a user, returns a bearer token, and provisions a tenant', async () => {
    const t = await buildTestApp()
    try {
      const response = await trpcMutation(t.app, 'auth.signupWithTenant', {
        email: 'alice@example.com',
        password: 'correct-horse-battery',
        name: 'Alice',
        tenantName: 'Acme',
        tenantSlug: 'acme',
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        result: {
          data: {
            token: string
            user: { id: string; email: string }
            tenant: { id: string; name: string; slug: string | null }
          }
        }
      }
      const data = body.result.data
      expect(data.user.email).toBe('alice@example.com')
      expect(data.tenant.name).toBe('Acme')
      expect(typeof data.token).toBe('string')
      expect(data.token.length).toBeGreaterThan(10)

      // The user should be able to call auth.me with the bearer token.
      const meResponse = await t.app.inject({
        method: 'GET',
        url: '/trpc/auth.me',
        headers: { authorization: `Bearer ${data.token}` },
      })
      expect(meResponse.statusCode).toBe(200)
      const me = meResponse.json() as { result: { data: { user: { email: string } } } }
      expect(me.result.data.user.email).toBe('alice@example.com')
    } finally {
      await t.close()
    }
  })

  it('rolls back the new user when tenant creation collides on slug', async () => {
    const t = await buildTestApp()
    try {
      // Pre-seed an organization with the slug the second signup will request.
      await t.pglite.query(
        `INSERT INTO "organization"(id, name, slug) VALUES ('preexisting-org', 'Existing', 'shared-slug')`,
      )
      const response = await trpcMutation(t.app, 'auth.signupWithTenant', {
        email: 'rollback@example.com',
        password: 'correct-horse-battery',
        name: 'Rollback',
        tenantName: 'Whatever',
        tenantSlug: 'shared-slug',
      })
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      const users = await t.pglite.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "user" WHERE email = $1`,
        ['rollback@example.com'],
      )
      // Rollback must have removed the orphaned user record.
      expect(users.rows[0]?.count).toBe(0)
      // Pre-existing org is preserved (we did not delete it).
      const orgs = await t.pglite.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "organization" WHERE slug = 'shared-slug'`,
      )
      expect(orgs.rows[0]?.count).toBe(1)
    } finally {
      await t.close()
    }
  })

  it('rejects duplicate signups for the same email', async () => {
    const t = await buildTestApp()
    try {
      const first = await trpcMutation(t.app, 'auth.signupWithTenant', {
        email: 'bob@example.com',
        password: 'correct-horse-battery',
        name: 'Bob',
        tenantName: 'Beta',
      })
      expect(first.statusCode).toBe(200)
      const second = await trpcMutation(t.app, 'auth.signupWithTenant', {
        email: 'bob@example.com',
        password: 'correct-horse-battery',
        name: 'Bob',
        tenantName: 'Beta2',
      })
      expect(second.statusCode).toBeGreaterThanOrEqual(400)
    } finally {
      await t.close()
    }
  })
})
