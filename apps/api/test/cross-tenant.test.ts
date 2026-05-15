import { computeHashHex } from '@c3-oss/prosa-storage'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

async function signup(t: TestApp, email: string, tenantName: string, tenantSlug: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName,
      tenantSlug,
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

async function trpc(t: TestApp, path: string, input: unknown, token: string) {
  return t.app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: input as never,
  })
}

describe('cross-tenant object attachment', () => {
  it('rejects a tenant referencing a source_file.object_id that belongs to another tenant', async () => {
    const t = await buildTestApp()
    try {
      // Tenant A uploads an object.
      const alice = await signup(t, 'cross-a@example.com', 'Alpha', 'cross-alpha')
      const bytes = new Uint8Array([1, 2, 3, 4])
      const hash = computeHashHex(bytes, 'blake3')

      const aliceHandshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0',
          device: { name: 'box-a' },
          store: { path: '/tmp/a', bundleVersion: '1' },
        },
        alice.token,
      )
      const aliceDevice = (aliceHandshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const alicePlan = await trpc(
        t,
        'sync.planUpload',
        {
          deviceId: aliceDevice,
          storePath: '/tmp/a',
          objects: [{ objectId: 'obj-shared', hash, hashAlgorithm: 'blake3', uncompressedSize: 4, compressedSize: 4 }],
        },
        alice.token,
      )
      const aliceBatch = (alicePlan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      // Upload bytes through the object route.
      const putResp = await t.app.inject({
        method: 'PUT',
        url: `/objects/obj-shared?hash=${hash}&size=4&uncompressed=4`,
        headers: {
          authorization: `Bearer ${alice.token}`,
          'content-type': 'application/octet-stream',
        },
        payload: Buffer.from(bytes),
      })
      expect([200, 201]).toContain(putResp.statusCode)

      const aliceCommit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: aliceBatch,
          deviceId: aliceDevice,
          storePath: '/tmp/a',
          objects: [{ objectId: 'obj-shared', hash, hashAlgorithm: 'blake3', uncompressedSize: 4, compressedSize: 4 }],
          projection: {
            sessions: [{ id: 'sess-a', sourceKind: 'codex', turnCount: 1 }],
          },
        },
        alice.token,
      )
      expect(aliceCommit.statusCode).toBe(200)

      // Tenant B tries to reference the same object_id WITHOUT declaring its
      // own tenant_object provenance. Sources with object_id pointing to an
      // object the tenant has not promoted must be rejected.
      const bob = await signup(t, 'cross-b@example.com', 'Beta', 'cross-beta')
      const bobHandshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0',
          device: { name: 'box-b' },
          store: { path: '/tmp/b', bundleVersion: '1' },
        },
        bob.token,
      )
      const bobDevice = (bobHandshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const bobPlan = await trpc(
        t,
        'sync.planUpload',
        { deviceId: bobDevice, storePath: '/tmp/b', objects: [] },
        bob.token,
      )
      const bobBatch = (bobPlan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const bobCommit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: bobBatch,
          deviceId: bobDevice,
          storePath: '/tmp/b',
          objects: [],
          projection: {
            sourceFiles: [
              {
                id: 'sf-b',
                sourceKind: 'codex',
                path: '/x',
                // Attempt to attach to Alice's object without declaring own provenance.
                objectId: 'obj-shared',
              },
            ],
            sessions: [{ id: 'sess-b', sourceKind: 'codex', turnCount: 1 }],
          },
        },
        bob.token,
      )
      // Composite FK in source_file rejects (tenant_id=bob, object_id=obj-shared)
      // because there is no matching tenant_object row for Bob's tenant.
      expect(bobCommit.statusCode).toBeGreaterThanOrEqual(400)

      // Verify Bob's tenant cannot see Alice's session either.
      const sessions = await t.app.inject({
        method: 'GET',
        url: '/trpc/sessions.list?input=%7B%7D',
        headers: { authorization: `Bearer ${bob.token}` },
      })
      const sessionIds = (sessions.json() as { result: { data: Array<{ id: string }> } }).result.data.map((r) => r.id)
      expect(sessionIds).not.toContain('sess-a')
    } finally {
      await t.close()
    }
  })
})
