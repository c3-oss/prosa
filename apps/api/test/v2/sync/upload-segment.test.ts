// Lane 5 slice 3 — `PUT /v2/promotions/:promotionId/segments/:segmentId`.
//
// Asserts:
// - the auth ladder still returns 401 / 403,
// - unknown promotion id → 404 PROMOTION_NOT_FOUND,
// - cross-tenant promotion id → 404 PROMOTION_NOT_FOUND (no leak),
// - segment id that BeginPromotion did not declare → 404
//   SEGMENT_NOT_DECLARED,
// - mismatched byteLength / digest / transport hash → 400 INVALID_REQUEST,
// - good upload writes to the MemoryObjectStore at the staging key and
//   returns `status: 'accepted'`,
// - re-upload of the same bytes is idempotent (`already_present`),
// - sealed/aborted promotion rejects new uploads.

import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

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

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

const PROJ_BYTES = new Uint8Array(64)
for (let i = 0; i < PROJ_BYTES.length; i++) PROJ_BYTES[i] = (i * 7) & 0xff

const OBJ_BYTES = new Uint8Array(96)
for (let i = 0; i < OBJ_BYTES.length; i++) OBJ_BYTES[i] = (i * 13 + 1) & 0xff

const OBJ_DIGEST = `blake3:${toHex(blake3(OBJ_BYTES))}`
const PROJ_DIGEST = `blake3:${toHex(blake3(PROJ_BYTES))}`

function buildBeginBody(opts: { tenantId: string }) {
  const storeId = 'store-up'
  const bundleRoot = 'aa'.repeat(32)
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
      rawSourceRoot: 'bb'.repeat(32),
      manifestDigest: `blake3:${'cc'.repeat(32)}`,
      counts: {
        sourceFiles: 0,
        rawRecords: 0,
        objects: 0,
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
        segmentId: 'seg-obj-1',
        kind: 'inventory_object',
        digest: OBJ_DIGEST,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: OBJ_BYTES.byteLength,
      },
      projectionInventorySegment: {
        segmentId: 'seg-proj-1',
        kind: 'inventory_projection',
        digest: PROJ_DIGEST,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: PROJ_BYTES.byteLength,
      },
    },
    device: { deviceId: 'dev-up' },
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
  const body = response.json() as { promotionId: string }
  return { promotionId: body.promotionId }
}

function uploadInjectArgs(opts: {
  token: string
  promotionId: string
  segmentId: string
  body: Uint8Array
  /** Overrides the auto-computed transport hash. Omit to use BLAKE3(body). */
  transportHash?: string
  /** Set true to omit the transport hash header entirely. */
  omitTransportHash?: boolean
  /** Override the device id sent in `x-prosa-device-id`. */
  deviceId?: string
  /** Set true to omit the device header entirely (negative test). */
  omitDevice?: boolean
}) {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    authorization: `Bearer ${opts.token}`,
  }
  if (!opts.omitTransportHash) {
    headers['x-prosa-transport-hash'] = opts.transportHash ?? `blake3:${toHex(blake3(opts.body))}`
  }
  if (!opts.omitDevice) {
    headers['x-prosa-device-id'] = opts.deviceId ?? 'dev-up'
  }
  return {
    method: 'PUT' as const,
    url: `/v2/promotions/${opts.promotionId}/segments/${opts.segmentId}`,
    headers,
    payload: Buffer.from(opts.body),
  }
}

describe('PUT /v2/promotions/:promotionId/segments/:segmentId — Lane 5 slice 3', () => {
  it('returns 401 to unauthenticated callers', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({
        method: 'PUT',
        url: '/v2/promotions/prm_abc/segments/seg-obj-1',
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from(OBJ_BYTES),
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
      const account = await signupWithTenant(t, 'up-404@example.com', 'Acme', 'acme-up-404')
      // CQ-127: register the device so the CQ-127 check passes
      // and we exercise the 404-PROMOTION_NOT_FOUND path.
      await t.db.rawExec(
        `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        ['dev-up', account.tenant.id, account.user.id, 'dev-up'],
      )
      const response = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId: 'prm_doesnotexist00000000000000',
          segmentId: 'seg-obj-1',
          body: OBJ_BYTES,
        }),
      )
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('does not leak a promotion across tenants (I1) — wrong tenant gets 404', async () => {
    const t = await buildTestApp()
    try {
      const accountA = await signupWithTenant(t, 'up-iso-a@example.com', 'Acme A', 'acme-up-iso-a')
      const accountB = await signupWithTenant(t, 'up-iso-b@example.com', 'Acme B', 'acme-up-iso-b')
      const { promotionId } = await openStaging(t, accountA.token, accountA.tenant.id)
      // CQ-127: register a tenant-B device so the device check
      // passes; the test exercises tenant isolation.
      await t.db.rawExec(
        `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        ['dev-up-b', accountB.tenant.id, accountB.user.id, 'dev-up-b'],
      )
      const response = await t.app.inject(
        uploadInjectArgs({
          token: accountB.token,
          promotionId,
          segmentId: 'seg-obj-1',
          body: OBJ_BYTES,
          deviceId: 'dev-up-b',
        }),
      )
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('returns 404 SEGMENT_NOT_DECLARED for a segment id that BeginPromotion did not declare', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'up-undeclared@example.com', 'Acme', 'acme-up-undecl')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      const response = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId,
          segmentId: 'seg-unknown',
          body: OBJ_BYTES,
        }),
      )
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('SEGMENT_NOT_DECLARED')
    } finally {
      await t.close()
    }
  })

  it('returns 400 with digest mismatch when the body bytes do not hash to the declared digest', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'up-digest@example.com', 'Acme', 'acme-up-digest')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      const wrongBytes = new Uint8Array(OBJ_BYTES.byteLength)
      wrongBytes.fill(0xff)
      const response = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId,
          segmentId: 'seg-obj-1',
          body: wrongBytes,
        }),
      )
      expect(response.statusCode).toBe(400)
      const body = response.json() as {
        code: string
        issues: Array<{ field: string; expected: string; received: string }>
      }
      expect(body.code).toBe('INVALID_REQUEST')
      expect(body.issues.some((i) => i.field === 'digest')).toBe(true)
    } finally {
      await t.close()
    }
  })

  it('returns 400 with byteLength mismatch when the body length does not match the declared segment', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'up-length@example.com', 'Acme', 'acme-up-length')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      const truncated = OBJ_BYTES.slice(0, OBJ_BYTES.byteLength - 1)
      const response = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId,
          segmentId: 'seg-obj-1',
          body: truncated,
        }),
      )
      expect(response.statusCode).toBe(400)
      const body = response.json() as {
        issues: Array<{ field: string }>
      }
      expect(body.issues.some((i) => i.field === 'byteLength')).toBe(true)
    } finally {
      await t.close()
    }
  })

  it('returns 400 when the x-prosa-transport-hash header disagrees with the streamed BLAKE3', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'up-transport@example.com', 'Acme', 'acme-up-transport')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      const response = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId,
          segmentId: 'seg-obj-1',
          body: OBJ_BYTES,
          transportHash: `blake3:${'00'.repeat(32)}`,
        }),
      )
      expect(response.statusCode).toBe(400)
      const body = response.json() as { issues: Array<{ field: string }> }
      expect(body.issues.some((i) => i.field === 'transportHash')).toBe(true)
    } finally {
      await t.close()
    }
  })

  it('accepts the upload, stores it at the staging key, and re-upload is already_present', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'up-ok@example.com', 'Acme', 'acme-up-ok')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)

      const first = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId,
          segmentId: 'seg-obj-1',
          body: OBJ_BYTES,
          transportHash: OBJ_DIGEST,
        }),
      )
      expect(first.statusCode).toBe(200)
      const firstBody = first.json() as { status: string; segmentId: string; storageKey: string }
      expect(firstBody.status).toBe('accepted')
      expect(firstBody.segmentId).toBe('seg-obj-1')
      expect(firstBody.storageKey).toBe(`staging/${account.tenant.id}/${promotionId}/seg-obj-1`)
      expect(await t.objectStore.head(firstBody.storageKey)).not.toBeNull()

      const second = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId,
          segmentId: 'seg-obj-1',
          body: OBJ_BYTES,
        }),
      )
      expect(second.statusCode).toBe(200)
      expect((second.json() as { status: string }).status).toBe('already_present')

      // Projection inventory also uploads successfully.
      const proj = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId,
          segmentId: 'seg-proj-1',
          body: PROJ_BYTES,
        }),
      )
      expect((proj.json() as { status: string }).status).toBe('accepted')
    } finally {
      await t.close()
    }
  })

  it('refuses uploads against sealed or aborted promotion staging rows', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'up-sealed@example.com', 'Acme', 'acme-up-sealed')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id)
      // Force the row into a terminal state out of band.
      await t.db.rawExec(`UPDATE promotion_staging SET status = 'aborted' WHERE id = $1`, [promotionId])

      const response = await t.app.inject(
        uploadInjectArgs({
          token: account.token,
          promotionId,
          segmentId: 'seg-obj-1',
          body: OBJ_BYTES,
        }),
      )
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })
})
