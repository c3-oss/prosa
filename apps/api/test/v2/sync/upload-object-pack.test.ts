// Lane 5 slice 4 — POST /v2/promotions/:promotionId/object-packs.
//
// Asserts:
// - unauthenticated → 401 UNAUTHENTICATED,
// - unknown promotion → 404 PROMOTION_NOT_FOUND,
// - cross-tenant promotion id → 404 PROMOTION_NOT_FOUND (I1),
// - non-pack bytes → 400 INVALID_REQUEST (verifyCasPack rejects),
// - declared `x-prosa-pack-digest` that disagrees with streamed
//   BLAKE3 → 400 with `packDigest` issue,
// - happy path: real `buildCasPack`-produced bytes → 200 accepted,
//   remote_pack + remote_pack_entry rows inserted, object stored at
//   `object-packs/<tenant>/<digest>.pack`, re-upload returns
//   `already_present` with no row duplication,
// - sealed/aborted promotion refuses uploads.

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}

const BEGIN_URL = '/v2/promotions/begin'

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
      result: { data: { token: string; user: { id: string }; tenant: { id: string } } }
    }
  ).result.data
}

function buildBeginBody(opts: { tenantId: string }) {
  const storeId = 'store-pack'
  const bundleRoot = 'dd'.repeat(32)
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId,
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId,
      storePath: '/home/test/store',
      epoch: 0,
      parserVersion: '0.1.0',
      createdAt: '2026-05-20T00:00:00.000Z',
      previousBundleRoot: null,
      bundleRoot,
      rawSourceRoot: 'ee'.repeat(32),
      manifestDigest: `blake3:${'ff'.repeat(32)}`,
      counts: {
        sourceFiles: 0,
        rawRecords: 0,
        objects: 2,
        sessions: 1,
        messages: 1,
        events: 0,
        contentBlocks: 0,
        turns: 0,
        toolCalls: 0,
        toolResults: 0,
        artifacts: 0,
        edges: 0,
        searchDocs: 1,
        projectionRows: 2,
      },
      segments: [],
    },
    inventories: {
      objectInventorySegment: {
        segmentId: 'seg-obj-pack',
        kind: 'inventory_object',
        digest: `blake3:${'aa'.repeat(32)}`,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: 64,
      },
      projectionInventorySegment: {
        segmentId: 'seg-proj-pack',
        kind: 'inventory_projection',
        digest: `blake3:${'bb'.repeat(32)}`,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: 64,
      },
    },
    device: { deviceId: 'dev-pack' },
  }
}

async function openStaging(t: TestApp, token: string, tenantId: string): Promise<{ promotionId: string }> {
  const response = await t.app.inject({
    method: 'POST',
    url: BEGIN_URL,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: buildBeginBody({ tenantId }) as never,
  })
  expect(response.statusCode).toBe(200)
  return { promotionId: (response.json() as { promotionId: string }).promotionId }
}

function uploadPackInjectArgs(opts: {
  token: string
  promotionId: string
  body: Uint8Array
  declaredPackDigest?: string
  /** Overrides the auto-computed transport hash. Omit to use BLAKE3(body). */
  transportHash?: string
  /** Set true to omit the transport hash header entirely. */
  omitTransportHash?: boolean
}) {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    authorization: `Bearer ${opts.token}`,
  }
  if (opts.declaredPackDigest) headers['x-prosa-pack-digest'] = opts.declaredPackDigest
  if (!opts.omitTransportHash) {
    headers['x-prosa-transport-hash'] = opts.transportHash ?? transportHashOf(opts.body)
  }
  return {
    method: 'POST' as const,
    url: `/v2/promotions/${opts.promotionId}/object-packs`,
    headers,
    payload: Buffer.from(opts.body),
  }
}

function buildTestPack() {
  const a = new TextEncoder().encode('alpha-object-content-aaaa')
  const b = new TextEncoder().encode('bravo-object-content-bbbb')
  return buildCasPack(
    [
      { bytes: a, compression: 'zstd' },
      { bytes: b, compression: 'zstd' },
    ],
    { createdAt: '2026-05-20T00:00:00.000Z' },
  )
}

describe('POST /v2/promotions/:promotionId/object-packs — Lane 5 slice 4', () => {
  it('returns 401 to unauthenticated callers', async () => {
    const t = await buildTestApp()
    try {
      const built = buildTestPack()
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/prm_anything/object-packs',
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from(built.bytes),
      })
      expect(response.statusCode).toBe(401)
      expect((response.json() as { code: string }).code).toBe('UNAUTHENTICATED')
    } finally {
      await t.close()
    }
  })

  it('returns 404 PROMOTION_NOT_FOUND for an unknown promotion id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'pk-404@example.com', 'Acme', 'acme-pk-404')
      const built = buildTestPack()
      const response = await t.app.inject(
        uploadPackInjectArgs({
          token: account.token,
          promotionId: 'prm_doesnotexist00000000000000',
          body: built.bytes,
        }),
      )
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('does not leak promotion ownership across tenants (I1)', async () => {
    const t = await buildTestApp()
    try {
      const accountA = await signupWithTenant(t, 'pk-iso-a@example.com', 'Acme A', 'acme-pk-iso-a')
      const accountB = await signupWithTenant(t, 'pk-iso-b@example.com', 'Acme B', 'acme-pk-iso-b')
      const { promotionId } = await openStaging(t, accountA.token, accountA.tenant.id)
      const built = buildTestPack()
      const response = await t.app.inject(
        uploadPackInjectArgs({ token: accountB.token, promotionId, body: built.bytes }),
      )
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('returns 400 when the body is not a valid CAS pack (verifyCasPack rejects)', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'pk-junk@example.com', 'Acme', 'acme-pk-junk')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      const junk = new Uint8Array(64)
      junk.fill(0x42)
      const response = await t.app.inject(uploadPackInjectArgs({ token: account.token, promotionId, body: junk }))
      expect(response.statusCode).toBe(400)
      const body = response.json() as { code: string; issues: Array<{ field: string }> }
      expect(body.code).toBe('INVALID_REQUEST')
      expect(body.issues.some((i) => i.field === 'pack')).toBe(true)
    } finally {
      await t.close()
    }
  })

  it('rejects declared x-prosa-pack-digest that does not match the streamed BLAKE3', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'pk-bad-digest@example.com', 'Acme', 'acme-pk-bad')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      const built = buildTestPack()
      const response = await t.app.inject(
        uploadPackInjectArgs({
          token: account.token,
          promotionId,
          body: built.bytes,
          declaredPackDigest: `blake3:${'00'.repeat(32)}`,
        }),
      )
      expect(response.statusCode).toBe(400)
      const body = response.json() as { issues: Array<{ field: string }> }
      expect(body.issues.some((i) => i.field === 'packDigest')).toBe(true)
    } finally {
      await t.close()
    }
  })

  it('accepts the pack, persists remote_pack + remote_pack_entry rows, and is idempotent on re-upload', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'pk-ok@example.com', 'Acme', 'acme-pk-ok')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      const built = buildTestPack()

      const first = await t.app.inject(
        uploadPackInjectArgs({
          token: account.token,
          promotionId,
          body: built.bytes,
          declaredPackDigest: built.packDigest,
          transportHash: transportHashOf(built.bytes),
        }),
      )
      expect(first.statusCode).toBe(200)
      const firstBody = first.json() as {
        status: string
        packDigest: string
        entryCount: number
        storageKey: string
      }
      expect(firstBody.status).toBe('accepted')
      expect(firstBody.packDigest).toBe(built.packDigest)
      expect(firstBody.entryCount).toBe(2)
      expect(firstBody.storageKey).toBe(
        `object-packs/${account.tenant.id}/${built.packDigest.slice('blake3:'.length)}.pack`,
      )
      expect(await t.objectStore.head(firstBody.storageKey)).not.toBeNull()

      const packRows = await t.db.rawExec<{ entry_count: number; byte_length: string | number }>(
        `SELECT entry_count, byte_length FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`,
        [account.tenant.id, built.packDigest],
      )
      expect(packRows.length).toBe(1)
      expect(Number(packRows[0]!.entry_count)).toBe(2)

      const entryRows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM remote_pack_entry WHERE tenant_id = $1 AND pack_digest = $2`,
        [account.tenant.id, built.packDigest],
      )
      expect(Number(entryRows[0]!.count)).toBe(2)

      // Re-upload of the same pack bytes is idempotent.
      const second = await t.app.inject(uploadPackInjectArgs({ token: account.token, promotionId, body: built.bytes }))
      expect(second.statusCode).toBe(200)
      const secondBody = second.json() as { status: string; entryCount: number }
      expect(secondBody.status).toBe('already_present')
      expect(secondBody.entryCount).toBe(2)

      // No duplicated rows.
      const after = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM remote_pack_entry WHERE tenant_id = $1 AND pack_digest = $2`,
        [account.tenant.id, built.packDigest],
      )
      expect(Number(after[0]!.count)).toBe(2)
    } finally {
      await t.close()
    }
  })

  it('refuses uploads against sealed or aborted promotion staging rows', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'pk-sealed@example.com', 'Acme', 'acme-pk-sealed')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      await t.db.rawExec(`UPDATE promotion_staging SET status = 'sealed' WHERE id = $1`, [promotionId])
      const built = buildTestPack()
      const response = await t.app.inject(
        uploadPackInjectArgs({ token: account.token, promotionId, body: built.bytes }),
      )
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })
})
