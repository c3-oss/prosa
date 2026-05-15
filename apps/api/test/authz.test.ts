import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

async function trpc(
  t: TestApp,
  path: string,
  input: unknown,
  token: string,
  method: 'POST' | 'GET' = 'POST',
  extraHeaders: Record<string, string> = {},
) {
  if (method === 'GET') {
    const q = encodeURIComponent(JSON.stringify(input))
    return t.app.inject({
      method: 'GET',
      url: `/trpc/${path}?input=${q}`,
      headers: { authorization: `Bearer ${token}`, ...extraHeaders },
    })
  }
  return t.app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extraHeaders },
    payload: input as never,
  })
}

async function signup(t: TestApp, email: string, tenantName: string, tenantSlug?: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName,
      ...(tenantSlug ? { tenantSlug } : {}),
    } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: {
        data: {
          token: string
          user: { id: string; email: string }
          tenant: { id: string; name: string; slug: string | null }
        }
      }
    }
  ).result.data
}

describe('tenant authorization (Mandatory correction queue item: tenant membership)', () => {
  it('rejects header-supplied tenant ids that the user is not a member of', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signup(t, 'authz-alice@example.com', 'Alpha', 'alpha-1')
      const bob = await signup(t, 'authz-bob@example.com', 'Beta', 'beta-1')

      // Bob tries to query sessions for Alice's tenant by spoofing the header.
      const response = await trpc(t, 'sessions.list', {}, bob.token, 'GET', {
        'x-prosa-tenant-id': alice.tenant.id,
      })
      expect(response.statusCode).toBe(403)
      expect(response.body).toContain('not a member')
    } finally {
      await t.close()
    }
  })

  it('rejects sync.planUpload when the requested tenant is not the caller', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signup(t, 'authz-plan-alice@example.com', 'Alpha', 'alpha-2')
      const bob = await signup(t, 'authz-plan-bob@example.com', 'Beta', 'beta-2')

      // Bob handshakes a device against his own tenant first (legit).
      const hs = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0',
          device: { name: 'bobs-laptop' },
          store: { path: '/tmp/bob', bundleVersion: '1' },
        },
        bob.token,
      )
      expect(hs.statusCode).toBe(200)

      // Bob spoofs the tenant header to try targeting Alice's tenant.
      const planResp = await trpc(
        t,
        'sync.planUpload',
        { deviceId: 'spoofed-device', storePath: '/tmp/wherever', objects: [] },
        bob.token,
        'POST',
        { 'x-prosa-tenant-id': alice.tenant.id },
      )
      expect(planResp.statusCode).toBe(403)
    } finally {
      await t.close()
    }
  })

  it('lets a real admin invite, but rejects non-admin members from inviting', async () => {
    const t = await buildTestApp()
    try {
      const admin = await signup(t, 'authz-admin@example.com', 'Org', 'org-x')

      // Admin invites bob via the tenant.invite admin procedure. The current
      // test cannot complete the multi-step invite-accept flow without email
      // links, so we instead test that a non-admin member cannot invite. For
      // that we manually insert a 'member' role row.
      await t.pglite.query(`INSERT INTO "user"(id, name, email, email_verified) VALUES ($1, $2, $3, true)`, [
        'u-member',
        'Mary Member',
        'member@example.com',
      ])
      await t.pglite.query(
        `INSERT INTO "account"(id, user_id, account_id, provider_id, password)
         VALUES ($1, $2, $3, $4, $5)`,
        ['acc-member', 'u-member', 'member@example.com', 'credential', '$2a$10$invalid-no-login'],
      )
      await t.pglite.query(`INSERT INTO "member"(id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
        'm-member',
        admin.tenant.id,
        'u-member',
        'member',
      ])

      // Create a Better Auth session row for the member by hand so we can hit
      // a protected procedure as them. Better Auth tokens are random nanoid
      // strings stored as the `token` column.
      const token = 'test-session-token-mary-member'
      await t.pglite.query(
        `INSERT INTO "session"(id, user_id, expires_at, token, active_organization_id)
         VALUES ($1, $2, now() + interval '1 day', $3, $4)`,
        ['sess-member', 'u-member', token, admin.tenant.id],
      )

      // Member tries to invite — should be rejected with FORBIDDEN.
      const inviteAsMember = await trpc(t, 'tenant.invite', { email: 'newcomer@example.com', role: 'member' }, token)
      expect(inviteAsMember.statusCode).toBe(403)
      expect(inviteAsMember.body).toContain('Admin role required')

      // Admin invites — should succeed (or at least not be a 403; Better Auth
      // may still return a server-side validation error if the invite plugin
      // changes shape, so we accept any non-403 response).
      const inviteAsAdmin = await trpc(
        t,
        'tenant.invite',
        { email: 'newcomer@example.com', role: 'member' },
        admin.token,
      )
      expect(inviteAsAdmin.statusCode).not.toBe(403)
    } finally {
      await t.close()
    }
  })

  it('resolves duplicate membership rows deterministically to the least privileged role', async () => {
    const t = await buildTestApp()
    try {
      const admin = await signup(t, 'authz-duplicate-member@example.com', 'DupOrg', 'dup-org')
      await t.pglite.query(`INSERT INTO "member"(id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
        'm-duplicate-member',
        admin.tenant.id,
        admin.user.id,
        'member',
      ])

      const me = await trpc(t, 'auth.me', {}, admin.token, 'GET')
      expect(me.statusCode).toBe(200)
      const meBody = me.json() as { result: { data: { memberRole: string | null } } }
      expect(meBody.result.data.memberRole).toBe('member')

      const invite = await trpc(t, 'tenant.invite', { email: 'dupe-target@example.com', role: 'member' }, admin.token)
      expect(invite.statusCode).toBe(403)
      expect(invite.body).toContain('Admin role required')
    } finally {
      await t.close()
    }
  })

  it('rejects PUT /objects/:id with a spoofed tenant header', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signup(t, 'object-alice@example.com', 'Alpha', 'object-alpha')
      const bob = await signup(t, 'object-bob@example.com', 'Beta', 'object-beta')

      // Bob (a real user) sends a PUT for an object claiming to target
      // Alice's tenant. The route must reject the spoofed header before
      // any bytes touch the object store.
      const response = await t.app.inject({
        method: 'PUT',
        url: '/objects/spoofed-obj?hash=aa&size=1&uncompressed=1',
        headers: {
          authorization: `Bearer ${bob.token}`,
          'x-prosa-tenant-id': alice.tenant.id,
          'content-type': 'application/octet-stream',
        },
        payload: Buffer.from([1]),
      })
      expect(response.statusCode).toBe(403)
    } finally {
      await t.close()
    }
  })

  it('rejects GET /objects/:id from a non-member', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signup(t, 'objread-alice@example.com', 'Alpha', 'objread-alpha')
      const bob = await signup(t, 'objread-bob@example.com', 'Beta', 'objread-beta')

      const response = await t.app.inject({
        method: 'GET',
        url: '/objects/some-object',
        headers: {
          authorization: `Bearer ${bob.token}`,
          'x-prosa-tenant-id': alice.tenant.id,
        },
      })
      expect(response.statusCode).toBe(403)
    } finally {
      await t.close()
    }
  })

  it('blocks unauthenticated requests to tenant procedures', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/trpc/sessions.list?input=%7B%7D',
      })
      expect(response.statusCode).toBe(401)
    } finally {
      await t.close()
    }
  })
})
