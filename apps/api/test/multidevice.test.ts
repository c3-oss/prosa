import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

async function trpc(t: TestApp, path: string, input: unknown, token: string, method: 'POST' | 'GET' = 'POST') {
  if (method === 'GET') {
    const q = encodeURIComponent(JSON.stringify(input))
    return t.app.inject({
      method: 'GET',
      url: `/trpc/${path}?input=${q}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }
  return t.app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: input as never,
  })
}

async function signup(t: TestApp, email: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName: 'Multi Co',
      tenantSlug: 'multi-co',
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

describe('multi-device remote-only reads', () => {
  it('lets device B query sessions uploaded by device A without any pull', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'multi-a@example.com')

      // Device A: promote a small bundle.
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0',
          device: { name: 'device-a', platform: 'linux' },
          store: { path: '/tmp/.prosa-a', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath: '/tmp/.prosa-a', objects: [] }, auth.token)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/.prosa-a',
          objects: [],
          projection: {
            sessions: [
              { id: 'sess-A1', sourceKind: 'codex', title: 'alpha', turnCount: 4 },
              { id: 'sess-A2', sourceKind: 'claude', title: 'beta', turnCount: 1 },
            ],
            searchDocs: [{ id: 'doc-A1', sessionId: 'sess-A1', kind: 'session', body: 'alpha discussion of widgets' }],
          },
        },
        auth.token,
      )
      await trpc(t, 'sync.verifyPromotion', { batchId, storePath: '/tmp/.prosa-a' }, auth.token)

      // Device B: logs in as the same user (same tenant), queries server.
      // For this in-process test the token is shared; in real life device B
      // would `auth login` with email/password to obtain its own session.
      const sessions = await trpc(t, 'sessions.list', {}, auth.token, 'GET')
      expect(sessions.statusCode).toBe(200)
      const sessionsBody = sessions.json() as {
        result: { data: Array<{ id: string; title: string | null; sourceKind: string }> }
      }
      expect(sessionsBody.result.data.map((s) => s.id).sort()).toEqual(['sess-A1', 'sess-A2'])

      const search = await trpc(t, 'search.query', { q: 'widgets' }, auth.token, 'GET')
      expect(search.statusCode).toBe(200)
      const searchBody = search.json() as {
        result: { data: Array<{ sessionId: string; snippet: string }> }
      }
      expect(searchBody.result.data).toHaveLength(1)
      expect(searchBody.result.data[0]?.sessionId).toBe('sess-A1')

      const analytics = await trpc(t, 'analytics.summary', undefined, auth.token, 'GET')
      const analyticsBody = analytics.json() as {
        result: {
          data: {
            counts: { sessions: number; docs: number }
            sources: Array<{ sourceKind: string; count: number }>
          }
        }
      }
      expect(analyticsBody.result.data.counts.sessions).toBe(2)
      expect(analyticsBody.result.data.sources.map((s) => s.sourceKind).sort()).toEqual(['claude', 'codex'])
    } finally {
      await t.close()
    }
  })

  it('isolates tenants: signups in different tenants cannot see each other', async () => {
    const t = await buildTestApp()
    try {
      // Tenant A
      const aliceResp = await t.app.inject({
        method: 'POST',
        url: '/trpc/auth.signupWithTenant',
        headers: { 'content-type': 'application/json' },
        payload: {
          email: 'alice@a.com',
          password: 'correct-horse-battery',
          name: 'Alice',
          tenantName: 'Alpha',
          tenantSlug: 'alpha',
        } as never,
      })
      const alice = (
        aliceResp.json() as {
          result: { data: { token: string; tenant: { id: string } } }
        }
      ).result.data
      const aliceHandshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0',
          device: { name: 'a-laptop' },
          store: { path: '/tmp/a', bundleVersion: '1' },
        },
        alice.token,
      )
      const aliceDevice = (aliceHandshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const alicePlan = await trpc(
        t,
        'sync.planUpload',
        { deviceId: aliceDevice, storePath: '/tmp/a', objects: [] },
        alice.token,
      )
      const aliceBatch = (alicePlan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: aliceBatch,
          deviceId: aliceDevice,
          storePath: '/tmp/a',
          objects: [],
          projection: { sessions: [{ id: 'a-secret', sourceKind: 'codex', turnCount: 1 }] },
        },
        alice.token,
      )

      // Tenant B
      const bobResp = await t.app.inject({
        method: 'POST',
        url: '/trpc/auth.signupWithTenant',
        headers: { 'content-type': 'application/json' },
        payload: {
          email: 'bob@b.com',
          password: 'correct-horse-battery',
          name: 'Bob',
          tenantName: 'Beta',
          tenantSlug: 'beta',
        } as never,
      })
      const bob = (bobResp.json() as { result: { data: { token: string } } }).result.data

      const sessions = await trpc(t, 'sessions.list', {}, bob.token, 'GET')
      expect(sessions.statusCode).toBe(200)
      const ids = (sessions.json() as { result: { data: Array<{ id: string }> } }).result.data.map((r) => r.id)
      expect(ids).not.toContain('a-secret')
    } finally {
      await t.close()
    }
  })
})
