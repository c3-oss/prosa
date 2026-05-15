import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

async function signup(t: TestApp, email: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName: email,
      tenantSlug: email.replaceAll(/[^a-z0-9]/g, '-'),
    } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: { data: { token: string; tenant: { id: string }; user: { id: string } } }
    }
  ).result.data
}

async function trpc(t: TestApp, path: string, input: unknown, token: string, method: 'POST' | 'GET' = 'POST') {
  if (method === 'GET') {
    return t.app.inject({
      method: 'GET',
      url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
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

async function openBatch(t: TestApp, token: string, storePath: string) {
  const handshake = await trpc(
    t,
    'sync.handshake',
    {
      cliVersion: '0.0.0-test',
      device: { name: `device-${storePath}`, platform: 'linux' },
      store: { path: storePath, bundleVersion: '1' },
    },
    token,
  )
  const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
  const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects: [] }, token)
  const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
  return { deviceId, batchId }
}

describe('sync transaction promotion integrity', () => {
  it('rolls back readable projection rows when commit fails after inserting a session', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-tx@example.com')
      const { deviceId, batchId } = await openBatch(t, auth.token, '/tmp/sync-tx')

      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/sync-tx',
          objects: [],
          projection: {
            sessions: [{ id: 'rolled-back-session', sourceKind: 'codex', turnCount: 1 }],
            rawRecords: [{ id: 'bad-raw-record', sourceFileId: 'missing-source-file', sequence: 0, payload: {} }],
          },
        },
        auth.token,
      )

      expect(commit.statusCode).toBe(500)
      const projectionRows = await t.pglite.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM "projection_session" WHERE tenant_id = $1 AND id = $2',
        [auth.tenant.id, 'rolled-back-session'],
      )
      expect(projectionRows.rows[0]?.count).toBe(0)

      const sessions = await trpc(t, 'sessions.list', {}, auth.token, 'GET')
      expect(sessions.statusCode).toBe(200)
      expect((sessions.json() as { result: { data: unknown[] } }).result.data).toEqual([])

      const status = await t.pglite.query<{ status: string }>('SELECT status FROM "sync_batch" WHERE id = $1', [
        batchId,
      ])
      expect(status.rows[0]?.status).toBe('failed')
    } finally {
      await t.close()
    }
  })

  it('rejects replaying a batch after a successful commit', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-replay@example.com')
      const { deviceId, batchId } = await openBatch(t, auth.token, '/tmp/sync-replay')
      const payload = {
        batchId,
        deviceId,
        storePath: '/tmp/sync-replay',
        objects: [],
        projection: { sessions: [{ id: 'sess-replay', sourceKind: 'codex', turnCount: 1 }] },
      }

      const first = await trpc(t, 'sync.commitUpload', payload, auth.token)
      const second = await trpc(t, 'sync.commitUpload', payload, auth.token)

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(412)
      expect(second.body).toContain('Batch is not open for commit')
    } finally {
      await t.close()
    }
  })
})
